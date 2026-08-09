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
 *  - Disk budget: the size/count/TTL caps are injected configuration
 *     (VS Code settings in production); entries above maxCacheableBytes
 *     are never cached; the byte budget counts unique inodes.
 *  - Content-addressed dedup: identical bytes are hardlinked to the
 *     first stored copy, so a file inside several archive backups
 *     occupies disk once. Entries without an origin record still dedup
 *     but are not orphan-tracked.
 *  - Orphan reclamation: the index records each entry's source archive
 *     (path + stat); the sweep reclaims entries whose archive was
 *     deleted, moved, or modified immediately, instead of waiting out
 *     the TTL. A missing/corrupt index never triggers mass deletion —
 *     unindexed entries fall back to the TTL.
 *  - Atomicity (one index.json, one atomic write per change): the cache
 *     files are the source of truth; the index is a rebuildable
 *     accelerator. store writes the file first, then the index; sweep
 *     unlinks files first, then prunes the index; clear removes
 *     everything. Every crash state self-heals to TTL reclamation.
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

/** Name of the single index file inside the cache dir. */
const INDEX_NAME = "index.json";
const INDEX_SCHEMA = 2;
/** Cap on the index read — a tampered giant file must not be parsed. */
const INDEX_MAX_BYTES = 64 * 1024;

/**
 * Origin of a cached preview: the archive it was extracted from. The
 * sweep compares it against the archive's live stat — a deleted, moved,
 * or modified archive makes the entry an orphan, reclaimed immediately
 * instead of lingering for the TTL.
 */
export interface PreviewCacheOrigin {
  archivePath: string;
  mtimeMs: number;
  size: number;
}

/**
 * One cache entry: everything the sweep and dedup need, stored together
 * so a single atomic write keeps the whole index consistent.
 */
interface CacheEntryRecord {
  /** Full content sha256 (64 hex) — dedup key. Never truncated: a
   *  truncated hash could link the wrong content. */
  contentHash: string;
  /** Source archive (orphan reclamation: deleted/moved/modified → reclaim). */
  archivePath: string;
  archiveMtimeMs: number;
  archiveSize: number;
}

/**
 * Single-file cache index (index.json, schema 2): cache-file basename →
 * entry record, merging what used to be two files (dedup manifest +
 * origin index). One file, one atomic tmp+rename — the whole index is
 * always consistent or absent.
 *
 * Atomicity protocol (the price of JSON over a transactional DB):
 *   - The cache files are the source of truth; the index is a
 *     rebuildable accelerator. Every failure degrades safely.
 *   - store: write the file first (atomic rename), then the index. A
 *     crash in between leaves a file with no entry — reclaimed by TTL.
 *   - sweep: unlink files first, rewrite the index last. A crash in
 *     between leaves dead references — pruned on the next sweep.
 *   - clear: everything goes; both crash states self-heal.
 *   - A corrupt/missing index reads as empty — dedup degrades to plain
 *     writes, orphan reclamation degrades to the TTL. Never mass-delete.
 */
interface CacheIndex {
  v: number;
  entries: Record<string, CacheEntryRecord>;
}

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
 * Dedup: entries whose content matches share one inode via hardlink.
 * The index maps basename → record; dedup scans it linearly (≤ maxFiles
 * entries) for the first file with the same content hash. Entries whose
 * file is gone are skipped — the sweep prunes them.
 */

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

function indexPath(): string {
  return path.join(cacheDir!, INDEX_NAME);
}

function readIndex(): CacheIndex {
  try {
    const st = fs.lstatSync(indexPath());
    if (!st.isFile() || st.size > INDEX_MAX_BYTES) return { v: INDEX_SCHEMA, entries: {} };
    const raw = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as Partial<CacheIndex>;
    if (raw.v !== INDEX_SCHEMA || typeof raw.entries !== "object" || raw.entries === null) {
      return { v: INDEX_SCHEMA, entries: {} };
    }
    const entries: Record<string, CacheEntryRecord> = {};
    for (const [name, rec] of Object.entries(raw.entries)) {
      // Keys are cache-file basenames (never escape the dir — a path
      // separator would turn a dedup link or sweep target into an
      // arbitrary path under the attacker's control).
      if (name !== path.basename(name)) continue;
      // Records must be well-formed; malformed entries degrade to TTL.
      if (
        !rec ||
        typeof rec !== "object" ||
        !CONTENT_HASH_RE.test(rec.contentHash) ||
        typeof rec.archivePath !== "string" ||
        typeof rec.archiveMtimeMs !== "number" ||
        typeof rec.archiveSize !== "number"
      ) {
        continue;
      }
      entries[name] = {
        contentHash: rec.contentHash,
        archivePath: rec.archivePath,
        archiveMtimeMs: rec.archiveMtimeMs,
        archiveSize: rec.archiveSize,
      };
    }
    return { v: INDEX_SCHEMA, entries };
  } catch {
    return { v: INDEX_SCHEMA, entries: {} };
  }
}

function writeIndex(index: CacheIndex): void {
  if (Object.keys(index.entries).length === 0) {
    // An empty index is a stale file: remove it.
    try {
      secureUnlink(indexPath());
    } catch {
      // Best effort.
    }
    return;
  }
  const tmp = `${indexPath()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}${CACHE_TMP_EXT}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(index), { flag: "wx" });
    fs.renameSync(tmp, indexPath());
  } catch {
    // Best-effort accelerator; a failed write degrades to plain stores
    // and TTL sweeps, never to corruption.
  }
}

/** Drop entries whose cache file no longer exists (swept/tampered). */
function pruneStaleIndexEntries(dir: string): void {
  const index = readIndex();
  const before = Object.keys(index.entries).length;
  for (const name of Object.keys(index.entries)) {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isFile()) continue;
    } catch {
      // Fall through: entry's file is gone.
    }
    delete index.entries[name];
  }
  if (Object.keys(index.entries).length !== before) writeIndex(index);
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
 *
 * `origin` records which archive the bytes came from, so the sweep can
 * reclaim the entry as an orphan as soon as that archive is deleted,
 * moved, or modified — instead of waiting out the TTL.
 *
 * Atomicity: the cache file lands first (tmp + atomic rename), then the
 * index (tmp + atomic rename). A crash between the two leaves a file
 * with no entry — reclaimed by the TTL, never served wrongly.
 */
export async function storePreviewCache(
  cacheFile: string,
  data: Uint8Array,
  origin?: PreviewCacheOrigin,
): Promise<void> {
  const index = readIndex();
  const hash = crypto.createHash(CACHE_HASH_ALGO).update(data).digest("hex");
  // Linear dedup scan: first index entry with the same content whose
  // file still exists (≤ maxFiles entries — cheap). Entries whose file
  // was swept are skipped here and pruned by the sweep.
  const existing = Object.entries(index.entries).find(([, rec]) => rec.contentHash === hash)?.[0];
  if (existing) {
    const existingPath = path.join(cacheDir!, existing);
    try {
      const st = fs.lstatSync(existingPath);
      if (st.isFile()) {
        fs.linkSync(existingPath, cacheFile);
        noteIndexEntry(cacheFile, hash, origin);
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
  noteIndexEntry(cacheFile, hash, origin);
  maybeSweepPreviewCache();
}

/**
 * Record the freshly stored file in the index (single atomic write).
 * Without an origin, the entry still dedups but is not orphan-tracked.
 */
function noteIndexEntry(cacheFile: string, contentHash: string, origin?: PreviewCacheOrigin): void {
  const index = readIndex();
  index.entries[path.basename(cacheFile)] = {
    contentHash,
    archivePath: origin?.archivePath ?? "",
    archiveMtimeMs: origin?.mtimeMs ?? 0,
    archiveSize: origin?.size ?? 0,
  };
  writeIndex(index);
}

/**
 * Remove every cached preview and the index. Used by the
 * "Clear Caches" command; also a fallback if a cache boundary is ever
 * violated. Idempotent; returns the number of files removed. Both crash
 * states self-heal: leftover index entries are pruned on the next sweep.
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
 * Throttled sweep: orphan reclamation, TTL expiry, then LRU pruning by
 * count and total bytes (preview files can be large, so a pure count cap
 * could leave gigabytes on disk). Orphans are entries whose source
 * archive was deleted, moved, or modified — the index records the
 * archive stat, so a mismatch reclaims them immediately instead of
 * waiting out the TTL. The byte budget counts unique inodes — hardlinked
 * dedup copies occupy disk once. The index is pruned to the files that
 * survive.
 */
export function sweepPreviewCache(dir: string, now = Date.now()): number {
  const config = getPreviewCacheConfig();
  const index = readIndex();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  const entries: { file: string; mtime: number; size: number; ino: number }[] = [];
  for (const name of names) {
    if (name === INDEX_NAME) continue; // the index is metadata, not a cache file
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
    // Orphan: the source archive is gone (deleted/moved) or changed
    // (mtime/size mismatch). Entries without a record (no origin passed,
    // or a missing/corrupt index) are kept — that must not cause mass
    // deletion, only TTL reclamation.
    const rec = index.entries[name];
    if (rec && rec.archivePath && !originMatches(rec)) {
      try {
        secureUnlink(file);
        removed++;
      } catch {
        // Best effort.
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

  pruneStaleIndexEntries(dir);
  return removed;
}

/** Live stat of the origin archive vs the recorded one — deleted, moved,
 *  or modified archives no longer match. */
function originMatches(rec: CacheEntryRecord): boolean {
  try {
    const st = fs.statSync(rec.archivePath);
    return st.isFile() && st.mtimeMs === rec.archiveMtimeMs && st.size === rec.archiveSize;
  } catch {
    return false;
  }
}

function maybeSweepPreviewCache(): void {
  if (!cacheDir) return;
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  const pruned = sweepPreviewCache(cacheDir, now);
  if (pruned > 0) logger.info({ event: "previewCache.pruned", pruned });
}
