/**
 * Archive delete operations — Smart Archive VSCode Extension
 *
 * Host-side dispatcher: the WASM mutation runs in the worker thread
 * (engines/modify-core); the system-7z fast path stays on the host.
 *
 * @module providers/archive/delete
 */

import { getFullExt, isWrappedFormat } from "../../constants";
import { logger } from "../../utils/logger";
import { hasSystem7zForFormat, deleteFromArchiveSystem7z } from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";

export async function deleteFromArchive(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);

  // Wrapped formats always mutate via WASM (worker).
  if (isWrappedFormat(ext)) {
    logger.info({ event: "deleteFromArchive.worker.wrapped", archivePath, ext });
    await runArchiveOp("modify", { action: "delete", archivePath, paths: selectedPaths, password });
    return;
  }

  // System 7z passes passwords via -p<password> on the command line,
  // visible in process listings. For encrypted archives, fall back to
  // WASM to avoid CLI password leakage.
  if (hasSystem7zForFormat(ext) && !password) {
    logger.info({ event: "deleteFromArchive.system7z", archivePath, ext });
    await deleteFromArchiveSystem7z(archivePath, selectedPaths, password);
    return;
  }

  logger.info({ event: "deleteFromArchive.worker", archivePath, ext });
  await runArchiveOp("modify", { action: "delete", archivePath, paths: selectedPaths, password });
}
