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
import { getFullExt } from "../constants";
import { logger } from "../utils/logger";

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
    logger.debug({ event: "fetchFileList.system7z", filePath });
    return listWithSystem7z(filePath, password);
  }

  return runArchiveOp<ListEntry[]>("list", { inputPath: filePath, password, data });
}
