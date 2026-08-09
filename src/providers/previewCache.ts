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
 *     the TTL. Orphan checks also run before every store (no hourly
 *     throttle), so deleting an archive shrinks the cache on the very
 *     next preview. A missing/corrupt index never triggers mass
 *     deletion — unindexed entries fall back to the TTL.
 *  - Atomicity (one index.json, one atomic write per change): the cache
 *     files are the source of truth; the index is a rebuildable
 *     accelerator. store writes the file first, then the index; sweep
 *     unlinks files first, then prunes the index; clear removes
 *     everything. Every crash state self-heals to TTL reclamation.
 *  - Untracked files: a cache file without an index record cannot dedup
 *     and cannot be orphan-checked — it is junk. While the index is
 *     healthy, the sweep drops such files outright (the crash window
 *     between file and index write self-heals via re-extraction) and
 *     the hit path refuses to serve them.
 *  - Content integrity: caches are rebuildable accelerators, so the
 *     worst case of any tampering is a re-extraction, never data loss.
 *     Both reuse points re-hash the bytes against the index record —
 *     a cache hit refuses mismatched content and the caller re-extracts
 *     (overwriting the bad copy), and a dedup hardlink only targets a
 *     verified file so a tampered inode does not spread. A cache file
 *     without an index record is untracked junk: the hit refuses it and
 *     the sweep unlinks it (the crash window between file and index
 *     write self-heals via re-extraction). The only files granted TTL
 *     grace are those seen while the index itself is missing/corrupt —
 *     an unreadable index must not trigger mass deletion. Encrypted
 *     archives never enter the cache.
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
/** Pre-schema-2 index files — dead names, removed once by the sweep. */
const V1_MANIFEST_NAME = "dedup-manifest.json";
const V1_ORIGINS_NAME = "origins.json";

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
 *
 * Content integrity: when the index records a hash for this file, the
 * bytes are re-hashed and compared — a file tampered in place (or an
 * index entry pointing at the wrong content) fails the check and the
 * caller re-extracts, overwriting the bad copy (self-healing). A file
 * without an index record is untracked junk and is refused too — the
 * caller re-extracts and re-stores it, which overwrites the junk with
 * a properly indexed copy. The only files served without a record are
 * those seen while the index itself is missing or corrupt: without the
 * index nothing can be verified, and refusing everything would turn a
 * plain crash into a lost cache.
 */
export function previewCacheHit(cacheFile: string): boolean {
  let st;
  try {
    st = fs.lstatSync(cacheFile);
    if (!st.isFile() || st.size > getPreviewCacheConfig().maxCacheableBytes) return false;
  } catch {
    return false;
  }
  const { entries, usable } = readIndex();
  const rec = entries[path.basename(cacheFile)];
  if (!rec) return !usable;
  try {
    const actual = crypto
      .createHash(CACHE_HASH_ALGO)
      .update(fs.readFileSync(cacheFile))
      .digest("hex");
    return actual === rec.contentHash;
  } catch {
    return false;
  }
}

function indexPath(): string {
  return path.join(cacheDir!, INDEX_NAME);
}

/**
 * Read the index. `usable` is false only when the index itself is
 * missing or unreadable (crash, corruption, a huge tampered file): with
 * no index, nothing can be verified, so every unindexed file gets TTL
 * grace instead of being dropped as junk. When `usable`, the entries
 * are the single source of truth — a file without a record is junk.
 */
function readIndex(): { entries: Record<string, CacheEntryRecord>; usable: boolean } {
  try {
    const st = fs.lstatSync(indexPath());
    if (!st.isFile() || st.size > INDEX_MAX_BYTES) return { entries: {}, usable: false };
    const raw = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as Partial<CacheIndex>;
    if (raw.v !== INDEX_SCHEMA || typeof raw.entries !== "object" || raw.entries === null) {
      return { entries: {}, usable: false };
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
    return { entries, usable: true };
  } catch {
    return { entries: {}, usable: false };
  }
}

function writeIndex(entries: Record<string, CacheEntryRecord>): void {
  if (Object.keys(entries).length === 0) {
    // An empty index is a stale file: remove it.
    try {
      secureUnlink(indexPath());
    } catch {
      // Best effort.
    }
    return;
  }
  const index: CacheIndex = { v: INDEX_SCHEMA, entries };
  const tmp = `${indexPath()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}${CACHE_TMP_EXT}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(index), { flag: "wx" });
    fs.renameSync(tmp, indexPath());
  } catch {
    // Best-effort accelerator; a failed write degrades to plain stores
    // and TTL sweeps, never to corruption.
  }
}

/**
 * Drop entries whose cache file no longer exists (swept/tampered).
 * Mutates the passed index; returns whether it changed (the caller
 * writes once).
 */
function pruneStaleIndexEntries(dir: string, entries: Record<string, CacheEntryRecord>): boolean {
  let changed = false;
  for (const name of Object.keys(entries)) {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isFile()) continue;
    } catch {
      // Fall through: entry's file is gone.
    }
    delete entries[name];
    changed = true;
  }
  return changed;
}

/**
 * Reclaim untrackable entries right now: every entry whose source
 * archive was deleted, moved, or modified (stat mismatch) — and every
 * entry with no origin record at all. An entry without an origin cannot
 * be verified against anything, so while the index is usable it is
 * dropped: production stores always pass an origin (modify.ts), so
 * origin-less entries are legacy back-fills and no-origin callers, not
 * working caches. Runs before every store (cheap: ≤ maxFiles stat
 * calls) so the cache shrinks on the very next preview after an archive
 * disappears, instead of waiting out the hourly throttle. Returns
 * whether the index changed (the caller writes once).
 */
function reclaimOrphans(entries: Record<string, CacheEntryRecord>): boolean {
  let changed = false;
  for (const [name, rec] of Object.entries(entries)) {
    if (rec.archivePath && originMatches(rec)) continue; // verifiable and alive
    try {
      secureUnlink(path.join(cacheDir!, name));
      delete entries[name];
      changed = true;
    } catch {
      // Best effort — the sweep retries.
    }
  }
  return changed;
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
 * `origin` records which archive the bytes came from, so the store
 * itself reclaims this entry as an orphan the moment that archive is
 * deleted, moved, or modified — the sweep only cleans up what the
 * store-based reclamation has not reached yet.
 *
 * Atomicity: the cache file lands first (tmp + atomic rename), then the
 * index (tmp + atomic rename). A crash between the two leaves a file
 * with no entry — dropped as junk by the next sweep, never served
 * wrongly.
 */
export async function storePreviewCache(
  cacheFile: string,
  data: Uint8Array,
  origin?: PreviewCacheOrigin,
): Promise<void> {
  const { entries, usable } = readIndex();
  if (usable && reclaimOrphans(entries)) writeIndex(entries);
  const hash = crypto.createHash(CACHE_HASH_ALGO).update(data).digest("hex");
  // Linear dedup scan: first index entry with the same content whose
  // file still exists (≤ maxFiles entries — cheap). Entries whose file
  // was swept are skipped here and pruned by the sweep.
  const existing = Object.entries(entries).find(([, rec]) => rec.contentHash === hash)?.[0];
  if (existing) {
    const existingPath = path.join(cacheDir!, existing);
    try {
      const st = fs.lstatSync(existingPath);
      // Re-hash the target before hardlinking: the dedup target is the
      // source of truth for every future copy, so a tampered file must
      // not spread — degrade to a plain write instead.
      if (st.isFile() && fileHashMatches(existingPath, hash)) {
        fs.linkSync(existingPath, cacheFile);
        entries[path.basename(cacheFile)] = {
          contentHash: hash,
          archivePath: origin?.archivePath ?? "",
          archiveMtimeMs: origin?.mtimeMs ?? 0,
          archiveSize: origin?.size ?? 0,
        };
        writeIndex(entries);
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
    try {
      secureUnlink(tmp);
    } catch {
      // Best effort.
    }
    throw err;
  }
  entries[path.basename(cacheFile)] = {
    contentHash: hash,
    archivePath: origin?.archivePath ?? "",
    archiveMtimeMs: origin?.mtimeMs ?? 0,
    archiveSize: origin?.size ?? 0,
  };
  writeIndex(entries);
  maybeSweepPreviewCache();
}

/** Re-hash a file and compare against an expected content hash. */
function fileHashMatches(file: string, expectedHash: string): boolean {
  try {
    const actual = crypto.createHash(CACHE_HASH_ALGO).update(fs.readFileSync(file)).digest("hex");
    return actual === expectedHash;
  } catch {
    return false;
  }
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
 * Throttled sweep: unindexed junk, orphan reclamation, TTL expiry, then
 * LRU pruning by count and total bytes (preview files can be large, so
 * a pure count cap could leave gigabytes on disk). Orphans are entries
 * whose source archive was deleted, moved, or modified — the index
 * records the archive stat, so a mismatch reclaims them immediately
 * instead of waiting out the TTL (the store also reclaims them before
 * every write, so the sweep only catches what the store has not).
 * Unindexed files are junk: while the index is healthy they are
 * dropped, and with it the crash window between file and index write
 * self-heals. The byte budget counts unique inodes — hardlinked dedup
 * copies occupy disk once. Surviving duplicates from before dedup
 * existed are merged (see mergeDuplicates). The index is pruned and
 * corrected in one write.
 */
export function sweepPreviewCache(dir: string, now = Date.now()): number {
  const config = getPreviewCacheConfig();
  const { entries, usable } = readIndex();
  const isOwnDir = dir === cacheDir;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  const survivors: { file: string; name: string; mtime: number; size: number; ino: number }[] = [];
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
    if (name === V1_MANIFEST_NAME || name === V1_ORIGINS_NAME) {
      // Pre-schema-2 index files: dead since the single index.json — one
      // sweep removes them once and for all.
      try {
        secureUnlink(file);
        removed++;
      } catch {
        // Best effort.
      }
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
    const rec = entries[name];
    if (rec && rec.archivePath && !originMatches(rec)) {
      // Orphan: the source archive is gone (deleted/moved) or changed
      // (mtime/size mismatch).
      try {
        secureUnlink(file);
        removed++;
      } catch {
        // Best effort.
      }
      continue;
    }
    if ((!rec || !rec.archivePath) && usable && isOwnDir) {
      // Untracked junk: a file the index does not know (crash-window
      // leftover, foreign copy) or an entry with no origin record
      // (legacy back-fill, no-origin caller) — neither can be verified
      // against any archive. With a healthy index the entries are the
      // single source of truth — the file is dropped and the caller
      // re-extracts on demand. Not applied to foreign dirs (a sweep over
      // an arbitrary directory must not delete what it cannot verify)
      // nor when the index itself is unusable (mass deletion risk).
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
    survivors.push({ file, name, mtime: st.mtimeMs, size: st.size, ino: st.ino });
  }

  survivors.sort((a, b) => a.mtime - b.mtime);
  const inodeBytes = new Map<number, number>();
  for (const e of survivors) {
    if (!inodeBytes.has(e.ino)) inodeBytes.set(e.ino, e.size);
  }
  let totalBytes = [...inodeBytes.values()].reduce((sum, v) => sum + v, 0);
  while (survivors.length > config.maxFiles || totalBytes > config.maxBytes) {
    const oldest = survivors.shift();
    if (!oldest) break;
    try {
      secureUnlink(oldest.file);
      removed++;
      // Free the bytes only when no other surviving entry shares the inode.
      if (!survivors.some((e) => e.ino === oldest.ino)) {
        totalBytes -= oldest.size;
      }
    } catch {
      // Best effort.
    }
  }

  const { merged, tampered } = mergeDuplicates(dir, survivors, entries);
  if (merged > 0) {
    // Merged copies are relinked, not deleted — the file count is
    // unchanged, only the disk bytes shrink, so `removed` is unaffected.
    logger.info({ event: "previewCache.dedupMerged", merged });
  }
  if (tampered > 0) removed += tampered;
  if (pruneStaleIndexEntries(dir, entries) || merged > 0 || tampered > 0) writeIndex(entries);
  return removed;
}

/**
 * Collapse surviving duplicates: files written before dedup existed (or
 * copied in from outside) occupy separate inodes for identical bytes.
 * Same-size groups with more than one inode are re-hashed (cheap
 * pre-filter: different sizes cannot be equal content) and hardlinked to
 * the first copy — the only surviving duplicates that were not merged at
 * write time.
 *
 * Doubles as an integrity pass for hashed files: a file whose bytes no
 * longer match its index record was tampered with — it is deleted, not
 * re-indexed, so the caller re-extracts the real bytes (self-healing;
 * re-indexing would bless the tampered copy).
 */
function mergeDuplicates(
  dir: string,
  entries: { file: string; name: string; size: number; ino: number }[],
  index: Record<string, CacheEntryRecord>,
): { merged: number; tampered: number } {
  const bySize = new Map<number, { file: string; name: string; ino: number }[]>();
  for (const e of entries) {
    const group = bySize.get(e.size);
    if (group) group.push({ file: e.file, name: e.name, ino: e.ino });
    else bySize.set(e.size, [{ file: e.file, name: e.name, ino: e.ino }]);
  }

  let merged = 0;
  let tampered = 0;
  for (const group of bySize.values()) {
    if (new Set(group.map((g) => g.ino)).size < 2) continue; // single copy — hit-time check covers it
    const byHash = new Map<string, string[]>();
    for (const g of group) {
      let hash: string;
      try {
        hash = crypto.createHash(CACHE_HASH_ALGO).update(fs.readFileSync(g.file)).digest("hex");
      } catch {
        continue; // unreadable — leave it to TTL
      }
      const rec = index[g.name];
      if (rec && rec.contentHash !== hash) {
        // Indexed file whose bytes changed: tampered. Delete the bad
        // copy — the next preview re-extracts the real bytes.
        try {
          secureUnlink(g.file);
          tampered++;
        } catch {
          // Best effort.
        }
        continue;
      }
      const names = byHash.get(hash);
      if (names) names.push(g.name);
      else byHash.set(hash, [g.name]);
    }
    for (const names of byHash.values()) {
      if (names.length >= 2) {
        const keep = names[0];
        for (const n of names.slice(1)) {
          try {
            secureUnlink(path.join(dir, n));
            fs.linkSync(path.join(dir, keep), path.join(dir, n));
            merged++;
          } catch {
            // Best effort — the duplicate just stays.
          }
        }
      }
    }
  }
  return { merged, tampered };
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
