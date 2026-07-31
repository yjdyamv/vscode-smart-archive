/**
 * Archive delete operations — Smart Archive VSCode Extension
 *
 * Host-side dispatcher: the WASM mutation runs in the worker thread
 * (engines/modify-core); the system-7z fast path (child process) stays
 * on the host. Both paths forward progress.
 *
 * @module providers/archive/delete
 */

import { getFullExt, isWrappedFormat } from "../../constants";
import { logger } from "../../utils/logger";
import { hasSystem7zForFormat, deleteFromArchiveSystem7z } from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";
import type { TokenLike, ProgressLike } from "../../utils/cancellation";

export async function deleteFromArchive(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<void> {
  const ext = getFullExt(archivePath);

  // Wrapped formats always mutate via WASM (worker).
  if (isWrappedFormat(ext)) {
    logger.info({ event: "deleteFromArchive.worker.wrapped", archivePath, ext });
    await runArchiveOp(
      "modify",
      { action: "delete", archivePath, paths: selectedPaths, password },
      progress,
      token,
    );
    return;
  }

  // System 7z passes passwords via -p<password> on the command line,
  // visible in process listings. For encrypted archives, fall back to
  // WASM to avoid CLI password leakage.
  if (hasSystem7zForFormat(ext) && !password) {
    logger.info({ event: "deleteFromArchive.system7z", archivePath, ext });
    await deleteFromArchiveSystem7z(archivePath, selectedPaths, password, progress, token);
    return;
  }

  logger.info({ event: "deleteFromArchive.worker", archivePath, ext });
  await runArchiveOp(
    "modify",
    { action: "delete", archivePath, paths: selectedPaths, password },
    progress,
    token,
  );
}
