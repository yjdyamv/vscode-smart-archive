/**
 * File listing dispatcher — Smart Archive VSCode Extension
 *
 * Host-side entry point for archive listing. Keeps the original
 * fetchFileList signature; the WASM work runs in the worker thread
 * (engines/fileListing-core). The system-7z fast path (child process)
 * stays on the host.
 *
 * @module providers/fileListing
 */

import { runArchiveOp } from "../engines/worker/runner";
import type { ListEntry } from "../engines/fileListing-core";
import { listWithSystem7z } from "../engines/system7z";
import { selectEngine } from "../engines/select-engine";
import { getFullExt, isWrappedFormat } from "../constants";
import { logger } from "../utils/logger";
import { getListingCacheDir, readListingCache, writeListingCache } from "./listingCache";

/**
 * Fetch the file list for an archive.
 *
 * Strategy (ordered by priority, see engines/select-engine):
 *   1. Wrapped formats (tar.gz etc.) — must extract to list (7z l doesn't traverse)
 *   2. System 7z child process — fast path
 *   3. WASM in the worker thread
 */
export async function fetchFileList(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<ListEntry[]> {
  const ext = getFullExt(filePath);
  const { engine } = selectEngine({ op: "list", ext, password, hasData: !!data });

  if (engine === "system7z") {
    logger.debug({ event: "fileListing.system7z", filePath });
    return listWithSystem7z(filePath, password);
  }

  // Wrapped formats only: repeat previews skip the full in-memory
  // extraction via the disk cache (stat + sha256 verified on read).
  // Note: a cache hit intentionally bypasses the archive-size gate in the
  // listing core — the gate protects the worker from reading an oversized
  // archive into memory, and a hit reads nothing at all.
  const cacheDir = isWrappedFormat(ext) && !data && !password ? getListingCacheDir() : null;
  if (cacheDir) {
    const cached = await readListingCache(cacheDir, filePath);
    if (cached) return cached;
  }

  const entries = await runArchiveOp<ListEntry[]>("list", { inputPath: filePath, password, data });

  if (cacheDir) {
    try {
      await writeListingCache(cacheDir, filePath, entries);
    } catch (err) {
      logger.warn({ event: "listingCache.writeFailed", err }, "Failed to write listing cache");
    }
  }
  return entries;
}
