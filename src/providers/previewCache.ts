/**
 * Preview cache — Smart Archive VSCode Extension
 *
 * Persistent cache for single-file previews of UNENCRYPTED archives: the
 * extracted file is keyed by sha256(archivePath | mtimeMs | size |
 * filePath), so an unchanged archive serves repeat previews instantly
 * (0ms vs 0.3-3s extraction) and a modified archive produces a fresh key.
 *
 * Security boundaries:
 *   - Encrypted archives NEVER use this cache — previewFileFromArchive
 *     routes password-protected previews to the session temp dir, which
 *     is deleted on document close. Persisting decrypted content would
 *     leak it to disk indefinitely.
 *   - Unencrypted archives: the cached bytes equal what anyone with the
 *     archive can extract, so no new exposure; the filename is a hash of
 *     the key inputs (no path or content in the name).
 *   - Hardening mirrors listingCache: atomic O_EXCL writes, lstat
 *     regular-file checks, a size-aware count/TTL sweep, 0o700 dir.
 *   - Disk budget: the size/count/TTL caps are injected configuration
 *     (VS Code settings in production); entries above maxCacheableBytes
 *     are never cached; the byte budget counts unique inodes.
 *   - Content-addressed dedup: identical bytes are hardlinked to the
 *     first stored copy via the dedup-manifest.json index, so a file
 *     inside several archive backups occupies disk once. The index is a
 *     best-effort accelerator — every failure degrades to a plain write.
 *
 * No orphan sweep: the raw content files carry no metadata about their
 * source archive; deleted archives' entries are reclaimed by the TTL and
 * count/byte caps instead.
 *
 * Vscode-free — the dir and config reader are injected via initPreviewCache.
 *
 * @module providers/previewCache
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CACHE_HASH_ALGO, CACHE_TMP_EXT } from "../constants";
import { logger } from "../utils/logger-core";
import { secureUnlink } from "../utils/fs";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Full content-hash shape enforced on dedup-index entries. */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

/** Name of the dedup index file inside the cache dir. */
const MANIFEST_NAME = "dedup-manifest.json";
const MANIFEST_SCHEMA = 1;
/** Cap on the manifest read — a tampered giant file must not be parsed. */
const MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * Disk budget, injected at init (VS Code settings in production; defaults
 * in tests). Read on every store/sweep so setting changes apply live.
 */
export interface PreviewCacheConfig {
  /** Entries above this size are never promoted into the persistent cache. */
  maxCacheableBytes: number;
  /** Idle TTL — entries not previewed for this long are swept. */
  ttlMs: number;
  /** Total byte budget (counted per unique inode, so deduped copies count once). */
  maxBytes: number;
  /** File-count budget. */
  maxFiles: number;
}

const DEFAULT_CONFIG: PreviewCacheConfig = {
  maxCacheableBytes: 10 * 1024 * 1024,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxBytes: 1024 * 1024 * 1024,
  maxFiles: 100,
};

/**
 * Dedup index: content sha256 (full 64 hex) → basename of the first cache
 * file holding that content. Repeated stores of identical bytes (same file
 * inside several archive backups, or a re-extraction after touch) hardlink
 * to that file instead of duplicating bytes on disk.
 *
 * The manifest is a best-effort accelerator, never a source of truth:
 * every failure path degrades to a plain write, and the sweep rebuilds it
 * from the surviving files. A truncated hash would risk linking the wrong
 * content, so the full sha256 is used here even though cache file names
 * truncate the key hash.
 */
interface DedupManifest {
  v: number;
  map: Record<string, string>;
}

let cacheDir: string | null = null;
let lastSweepAt = 0;
let readConfig: (() => Partial<PreviewCacheConfig>) | null = null;

export function getPreviewCacheConfig(): PreviewCacheConfig {
  return { ...DEFAULT_CONFIG, ...(readConfig ? readConfig() : {}) };
}

export function getPreviewCacheDir(): string | null {
  return cacheDir;
}

/**
 * Initialize the cache directory (extension activate) and sweep stale files.
 * `configReader` is injected so the module stays vscode-free; it is invoked
 * on every store/sweep to pick up live setting changes.
 */
export function initPreviewCache(
  dir: string,
  configReader?: () => Partial<PreviewCacheConfig>,
): void {
  cacheDir = dir;
  readConfig = configReader ?? null;
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort — permission hardening only.
    }
  }
  const pruned = sweepPreviewCache(dir);
  lastSweepAt = Date.now();
  if (pruned > 0) logger.info({ event: "previewCache.pruned", pruned });
}

/** Stable cache file name: sha256(archive|mtime|size|file) + the entry's extension. */
export function previewCachePath(
  archivePath: string,
  mtimeMs: number,
  size: number,
  filePath: string,
  ext: string,
): string {
  if (!cacheDir) throw new Error("preview cache not initialized");
  const digest = crypto
    .createHash(CACHE_HASH_ALGO)
    .update(`${archivePath}|${mtimeMs}|${size}|${filePath}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(cacheDir, `${digest}${ext}`);
}

/**
 * Verify a cache hit before serving it. The path is derived from public
 * inputs (archive path + stat), so a same-user attacker can plant a
 * symlink or FIFO at the computed location: opening a symlink in the
 * editor would disclose the attacker's chosen file, and a FIFO would
 * hang it. Non-regular files are refused and the caller extracts fresh.
 * Files above the cacheable size are refused too — they should never be
 * in the cache (old leftovers get extracted fresh and swept).
 */
export function previewCacheHit(cacheFile: string): boolean {
  try {
    const st = fs.lstatSync(cacheFile);
    return st.isFile() && st.size <= getPreviewCacheConfig().maxCacheableBytes;
  } catch {
    return false;
  }
}

function manifestPath(): string {
  return path.join(cacheDir!, MANIFEST_NAME);
}

function readManifest(): DedupManifest {
  try {
    const st = fs.lstatSync(manifestPath());
    if (!st.isFile() || st.size > MANIFEST_MAX_BYTES) return { v: MANIFEST_SCHEMA, map: {} };
    const raw = JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as Partial<DedupManifest>;
    if (raw.v !== MANIFEST_SCHEMA || typeof raw.map !== "object" || raw.map === null) {
      return { v: MANIFEST_SCHEMA, map: {} };
    }
    const map: Record<string, string> = {};
    for (const [hash, name] of Object.entries(raw.map)) {
      // Reject malformed hashes and any name that could escape the cache
      // dir (path separators would turn the link target into an arbitrary
      // path under the attacker's control).
      if (!CONTENT_HASH_RE.test(hash)) continue;
      if (typeof name !== "string" || name !== path.basename(name)) continue;
      map[hash] = name;
    }
    return { v: MANIFEST_SCHEMA, map };
  } catch {
    return { v: MANIFEST_SCHEMA, map: {} };
  }
}

function writeManifest(manifest: DedupManifest): void {
  if (Object.keys(manifest.map).length === 0) {
    // An empty index is a stale file: remove it.
    try {
      secureUnlink(manifestPath());
    } catch {
      // Best effort.
    }
    return;
  }
  const tmp = `${manifestPath()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}${CACHE_TMP_EXT}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest), { flag: "wx" });
    fs.renameSync(tmp, manifestPath());
  } catch {
    // The manifest is a best-effort accelerator; a failed write degrades
    // to plain stores (duplicate bytes), never to corruption.
  }
}

/** Drop manifest entries whose file no longer exists (swept/tampered). */
function pruneStaleManifestEntries(dir: string): void {
  const manifest = readManifest();
  const before = Object.keys(manifest.map).length;
  for (const [hash, name] of Object.entries(manifest.map)) {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isFile()) continue;
    } catch {
      // Fall through: entry's file is gone.
    }
    delete manifest.map[hash];
  }
  if (Object.keys(manifest.map).length !== before) writeManifest(manifest);
}

/**
 * Atomically store an extracted preview. Fails (throws) if the target
 * already exists — the caller checks first; a racing writer means the
 * other copy is identical (same key), so keeping it is fine.
 *
 * Content-addressed dedup: if the same bytes were cached before, the new
 * entry hardlinks to the existing inode instead of duplicating them (a
 * file inside several archive backups, or a re-extraction after a touch,
 * occupies disk once). Every failure path degrades to a plain write.
 */
export async function storePreviewCache(cacheFile: string, data: Uint8Array): Promise<void> {
  const manifest = readManifest();
  const hash = crypto.createHash(CACHE_HASH_ALGO).update(data).digest("hex");
  const existing = manifest.map[hash];
  if (existing) {
    const existingPath = path.join(cacheDir!, existing);
    try {
      const st = fs.lstatSync(existingPath);
      if (st.isFile()) {
        fs.linkSync(existingPath, cacheFile);
        maybeSweepPreviewCache();
        return;
      }
    } catch {
      // Missing/stale target: fall through to a plain write.
    }
  }
  const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}${CACHE_TMP_EXT}`;
  try {
    await fs.promises.writeFile(tmp, data, { flag: "wx" });
    await fs.promises.rename(tmp, cacheFile);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  manifest.map[hash] = path.basename(cacheFile);
  writeManifest(manifest);
  maybeSweepPreviewCache();
}

/**
 * Remove every cached preview and the dedup index. Used by the
 * "Clear Caches" command; also a fallback if a cache boundary is ever
 * violated. Idempotent; returns the number of files removed.
 */
export function clearPreviewCache(): number {
  if (!cacheDir) return 0;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(cacheDir)) {
      try {
        secureUnlink(path.join(cacheDir, name));
        removed++;
      } catch {
        // Best effort.
      }
    }
  } catch {
    // Best effort.
  }
  return removed;
}

/**
 * Throttled sweep: TTL expiry, then LRU pruning by count and total bytes
 * (preview files can be large, so a pure count cap could leave gigabytes
 * on disk). The byte budget counts unique inodes — hardlinked dedup
 * copies occupy disk once. The dedup index is rebuilt from the files
 * that survive.
 */
export function sweepPreviewCache(dir: string, now = Date.now()): number {
  const config = getPreviewCacheConfig();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  const entries: { file: string; mtime: number; size: number; ino: number }[] = [];
  for (const name of names) {
    if (name === MANIFEST_NAME) continue; // indexed metadata, not a cache file
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(file);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (name.endsWith(CACHE_TMP_EXT)) {
      if (now - st.mtimeMs > SWEEP_INTERVAL_MS) {
        try {
          secureUnlink(file);
          removed++;
        } catch {
          // Best effort.
        }
      }
      continue;
    }
    if (now - st.mtimeMs > config.ttlMs) {
      try {
        secureUnlink(file);
        removed++;
      } catch {
        // Best effort.
      }
      continue;
    }
    entries.push({ file, mtime: st.mtimeMs, size: st.size, ino: st.ino });
  }

  entries.sort((a, b) => a.mtime - b.mtime);
  const inodeBytes = new Map<number, number>();
  for (const e of entries) {
    if (!inodeBytes.has(e.ino)) inodeBytes.set(e.ino, e.size);
  }
  let totalBytes = [...inodeBytes.values()].reduce((sum, v) => sum + v, 0);
  while (entries.length > config.maxFiles || totalBytes > config.maxBytes) {
    const oldest = entries.shift();
    if (!oldest) break;
    try {
      secureUnlink(oldest.file);
      removed++;
      // Free the bytes only when no other surviving entry shares the inode.
      if (!entries.some((e) => e.ino === oldest.ino)) {
        totalBytes -= oldest.size;
      }
    } catch {
      // Best effort.
    }
  }

  pruneStaleManifestEntries(dir);
  return removed;
}

function maybeSweepPreviewCache(): void {
  if (!cacheDir) return;
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  const pruned = sweepPreviewCache(cacheDir, now);
  if (pruned > 0) logger.info({ event: "previewCache.pruned", pruned });
}
