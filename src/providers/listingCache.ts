/**
 * Listing cache — Smart Archive VSCode Extension
 *
 * Disk cache for wrapped-format listings (tar.gz etc.). Wrapped listing is
 * the most expensive op in the extension — the whole archive is read into
 * memory and fully decompressed (twice for 7z-readable codecs) before the
 * inner tar tree can be read. Persisting the flat entry list keyed by the
 * archive path hash turns repeat previews into a stat + small JSON read.
 *
 * Freshness policy — the source archive's size+mtime is the fast check
 * (zero IO); a streaming sha256 of the archive is the fallback when stat
 * changed (covers touch/copy without content change). The content hash is
 * the single source of truth: mutation ops (add/delete/rename) never need
 * to invalidate the cache, the next read re-verifies.
 *
 * Cleanup policy — a three-pronged sweep runs at activate and amortized
 * hourly during a session: TTL expiry (entries not verified for 30 days),
 * orphaned entries (source archive no longer exists), and an LRU count
 * cap.
 *
 * Security boundary — a same-user attacker who can write globalStorage can
 * already replace the extension itself, so the cache is NOT an integrity
 * boundary against such tampering. What the cache must not be is a vector
 * beyond the directory it owns: tmp writes use O_EXCL so a pre-placed
 * symlink is never followed, non-regular files (FIFO/device) are rejected
 * before reads so a hostile entry cannot hang the extension, poisoned
 * snapshots are bounded by entry/file caps, and the directory is
 * chmod 0o700.
 *
 * Vscode-free core — the cacheDir is injected (initListingCache) so tests
 * run without the vscode double.
 *
 * @module providers/listingCache
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ListEntry } from "../engines/fileListing-core";
import { logger } from "../utils/logger-core";
import { secureUnlink } from "../utils/fs";

const SCHEMA_VERSION = 1;
const MAX_CACHE_FILES = 100;
const MAX_CACHE_ENTRIES = 100_000;
const MAX_CACHE_FILE_BYTES = 64 * 1024 * 1024;
const STALE_TMP_MS = 60 * 60 * 1000;
const HASH_CHUNK = 1 << 20;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface CachedListing {
  v: number;
  size: number;
  mtimeMs: number;
  sha256: string;
  writtenAt: number;
  sourcePath: string;
  entries: ListEntry[];
}

let _cacheDir: string | null = null;
let lastSweepAt = 0;

export function getListingCacheDir(): string | null {
  return _cacheDir;
}

/**
 * Initialize the cache directory (extension activate): create it and sweep
 * stale entries (TTL / orphan / count).
 */
export function initListingCache(dir: string): void {
  _cacheDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort — permission hardening only.
    }
  }
  const pruned = sweepListingCache(dir);
  lastSweepAt = Date.now();
  if (pruned > 0) logger.info({ event: "listingCache.pruned", pruned });
}

/** Stable cache file name for an archive path — sha256 of the path. */
export function cacheFilePath(dir: string, filePath: string): string {
  const digest = crypto.createHash("sha256").update(filePath).digest("hex");
  return path.join(dir, `${digest}.json`);
}

/**
 * Remove every cached listing (the "Clear Caches" command). Idempotent;
 * returns the number of files removed.
 */
export function clearListingCache(): number {
  if (!_cacheDir) return 0;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(_cacheDir)) {
      try {
        secureUnlink(path.join(_cacheDir, name));
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
 * Streaming sha256 of a file — the content-verification fallback. A full
 * read is still an order of magnitude cheaper than the wrapped listing it
 * guards.
 */
export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await fd.close();
  }
  return hash.digest("hex");
}

/**
 * Read a cached listing. Returns the entries when the source archive is
 * unchanged (stat fast check, then sha256 fallback), null otherwise —
 * missing/corrupt cache files are treated as a miss.
 */
export async function readListingCache(
  cacheDir: string,
  filePath: string,
): Promise<ListEntry[] | null> {
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  let raw: CachedListing;
  try {
    const cacheFile = cacheFilePath(cacheDir, filePath);
    const lst = await fs.promises.lstat(cacheFile);
    // Reject non-regular files (FIFO/device/symlink) before any read —
    // a hostile entry must never hang or redirect the extension.
    if (!lst.isFile() || lst.size > MAX_CACHE_FILE_BYTES) return null;
    const text = await fs.promises.readFile(cacheFile, "utf8");
    raw = JSON.parse(text) as CachedListing;
    if (raw.v !== SCHEMA_VERSION || !Array.isArray(raw.entries)) throw new Error("bad schema");
    if (raw.entries.length > MAX_CACHE_ENTRIES) return null;
  } catch {
    return null;
  }

  if (st.size === raw.size && st.mtimeMs === raw.mtimeMs) {
    logger.debug({ event: "listingCache.hit", filePath, reason: "stat" });
    return raw.entries;
  }

  // Stat changed — verify content before trusting the cached tree.
  let digest: string;
  try {
    digest = await hashFile(filePath);
  } catch {
    return null;
  }
  if (digest === raw.sha256) {
    try {
      await writeSnapshot(cacheFilePath(cacheDir, filePath), {
        ...raw,
        size: st.size,
        mtimeMs: st.mtimeMs,
        writtenAt: Date.now(),
      });
    } catch {
      // Best effort — the entries are still valid.
    }
    logger.debug({ event: "listingCache.hit", filePath, reason: "hash" });
    return raw.entries;
  }
  logger.debug({ event: "listingCache.miss", filePath, reason: "content-changed" });
  return null;
}

/**
 * Snapshot a fresh listing to disk: stat + sha256 of the source plus the
 * entry list, written atomically (temp file + rename). Best-effort from
 * the caller's perspective — cache failures never fail the listing.
 */
export async function writeListingCache(
  cacheDir: string,
  filePath: string,
  entries: ListEntry[],
): Promise<void> {
  const st = await fs.promises.stat(filePath);
  const sha256 = await hashFile(filePath);
  const snapshot: CachedListing = {
    v: SCHEMA_VERSION,
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256,
    writtenAt: Date.now(),
    sourcePath: filePath,
    entries,
  };
  await writeSnapshot(cacheFilePath(cacheDir, filePath), snapshot);
  maybeSweepListingCache(cacheDir);
  logger.info({ event: "listingCache.write", filePath, entries: entries.length });
}

async function writeSnapshot(cacheFile: string, snapshot: CachedListing): Promise<void> {
  await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
  const data = JSON.stringify(snapshot);
  let tmp = "";
  for (let attempt = 0; ; attempt++) {
    tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      // O_EXCL: never follow a pre-placed symlink at the tmp name.
      await fs.promises.writeFile(tmp, data, { flag: "wx" });
      break;
    } catch (err) {
      if (attempt >= 2 || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  try {
    await fs.promises.rename(tmp, cacheFile);
  } catch (err) {
    try {
      // Windows: rename cannot replace a destination that is open by
      // another process or is a symlink (EPERM) — unlink and retry once.
      // A removed stale cache is acceptable: the next read is a miss and
      // the next write recreates it.
      await fs.promises.rm(cacheFile, { force: true });
      await fs.promises.rename(tmp, cacheFile);
      return;
    } catch {
      // Best effort — the caller treats cache failures as non-fatal.
    }
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Prune cache files beyond maxFiles, oldest mtime first (mirrors
 * tempFiles.pruneOldPreviews). Returns the number of files removed.
 */
export function pruneListingCache(cacheDir: string, maxFiles = MAX_CACHE_FILES): number {
  if (maxFiles <= 0) return 0;
  let files: string[];
  try {
    files = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  if (files.length <= maxFiles) return 0;

  const byMtime = files
    .map((name) => ({ name, mtime: fs.statSync(path.join(cacheDir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  let pruned = 0;
  while (byMtime.length > maxFiles) {
    const oldest = byMtime.shift()!;
    try {
      secureUnlink(path.join(cacheDir, oldest.name));
      pruned++;
    } catch {
      // Best effort.
    }
  }
  return pruned;
}

/**
 * Full cleanup pass: TTL expiry, orphaned entries (source archive gone),
 * corrupt files, stale crash leftovers (.tmp), then the LRU count cap.
 * Returns the number removed.
 */
export function sweepListingCache(cacheDir: string, now = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    const cacheFile = path.join(cacheDir, name);
    if (name.endsWith(".tmp")) {
      if (isStaleTmp(cacheFile, now)) {
        try {
          secureUnlink(cacheFile);
          removed++;
        } catch {
          // Best effort.
        }
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    if (!shouldKeepSnapshot(cacheFile, now)) {
      try {
        secureUnlink(cacheFile);
        removed++;
      } catch {
        // Best effort.
      }
    }
  }
  return removed + pruneListingCache(cacheDir);
}

function isStaleTmp(tmpFile: string, now: number): boolean {
  try {
    const st = fs.lstatSync(tmpFile);
    if (!st.isFile()) return false;
    return now - st.mtimeMs > STALE_TMP_MS;
  } catch {
    return false;
  }
}

function shouldKeepSnapshot(cacheFile: string, now: number): boolean {
  let snap: Partial<CachedListing>;
  try {
    const lst = fs.lstatSync(cacheFile);
    // Non-regular files (FIFO/device/symlink) would hang or redirect the
    // read below — remove them instead.
    if (!lst.isFile() || lst.size > MAX_CACHE_FILE_BYTES) return false;
    snap = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Partial<CachedListing>;
  } catch {
    return false;
  }
  if (snap.v !== SCHEMA_VERSION) return false;
  if (typeof snap.writtenAt !== "number" || now - snap.writtenAt > CACHE_TTL_MS) return false;
  if (typeof snap.sourcePath !== "string" || !fs.existsSync(snap.sourcePath)) return false;
  return true;
}

/**
 * Throttled sweep: runs at most once per SWEEP_INTERVAL_MS. Called from
 * writeListingCache so a long-lived session cannot grow unbounded; the
 * activate sweep sets lastSweepAt so the first write does not re-sweep.
 */
export function maybeSweepListingCache(cacheDir: string, now = Date.now()): number {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now;
  return sweepListingCache(cacheDir, now);
}
