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
 *
 * No orphan sweep: the raw content files carry no metadata about their
 * source archive; deleted archives' entries are reclaimed by the TTL and
 * count/byte caps instead.
 *
 * Vscode-free — the dir is injected via initPreviewCache.
 *
 * @module providers/previewCache
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger-core";
import { secureUnlink } from "../utils/fs";

const PREVIEW_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_CACHE_MAX_FILES = 100;
const PREVIEW_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let cacheDir: string | null = null;
let lastSweepAt = 0;

export function getPreviewCacheDir(): string | null {
  return cacheDir;
}

/** Initialize the cache directory (extension activate) and sweep stale files. */
export function initPreviewCache(dir: string): void {
  cacheDir = dir;
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
    .createHash("sha256")
    .update(`${archivePath}|${mtimeMs}|${size}|${filePath}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(cacheDir, `${digest}${ext}`);
}

/**
 * Atomically store an extracted preview. Fails (throws) if the target
 * already exists — the caller checks first; a racing writer means the
 * other copy is identical (same key), so keeping it is fine.
 */
export async function storePreviewCache(cacheFile: string, data: Uint8Array): Promise<void> {
  const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, { flag: "wx" });
    await fs.promises.rename(tmp, cacheFile);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  maybeSweepPreviewCache();
}

/**
 * Throttled sweep: TTL expiry, then LRU pruning by count and total bytes
 * (preview files can be up to MAX_PREVIEW_FILE_SIZE each, so a pure count
 * cap could leave gigabytes on disk).
 */
export function sweepPreviewCache(dir: string, now = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  const entries: { file: string; mtime: number; size: number }[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(file);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (name.endsWith(".tmp")) {
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
    if (now - st.mtimeMs > PREVIEW_CACHE_TTL_MS) {
      try {
        secureUnlink(file);
        removed++;
      } catch {
        // Best effort.
      }
      continue;
    }
    entries.push({ file, mtime: st.mtimeMs, size: st.size });
  }

  entries.sort((a, b) => a.mtime - b.mtime);
  let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  while (entries.length > PREVIEW_CACHE_MAX_FILES || totalBytes > PREVIEW_CACHE_MAX_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    try {
      secureUnlink(oldest.file);
      removed++;
      totalBytes -= oldest.size;
    } catch {
      // Best effort.
    }
  }
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
