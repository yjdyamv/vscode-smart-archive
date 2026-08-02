/**
 * Archive delete operations — Smart Archive VSCode Extension
 *
 * Host-side dispatcher: the WASM mutation runs in the worker thread
 * (engines/modify-core); the system-7z fast path (child process) stays
 * on the host. Both paths forward progress.
 *
 * @module providers/archive/delete
 */

import * as fs from "fs";
import { isRarExt } from "../../utils/rar";
import { getFullExt, isWrappedFormat } from "../../constants";
import { logger } from "../../utils/logger";
import { hasSystem7zForFormat, deleteFromArchiveSystem7z } from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";
import { rebuildRarArchive, archiveJoin } from "./rar5-modify";
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

  // 7-Zip cannot modify RAR archives (E_NOTIMPL) — rebuild instead.
  if (isRarExt(ext)) {
    logger.info({ event: "deleteFromArchive.rar5.rebuild", archivePath, ext });
    await rebuildRarArchive({
      archivePath,
      password,
      progress,
      token,
      mutate: (root) => {
        for (const p of selectedPaths) {
          fs.rmSync(archiveJoin(root, p), { recursive: true, force: true });
        }
      },
    });
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
