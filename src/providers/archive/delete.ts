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
import { getFullExt, isWrappedFormat } from "../../constants";
import { logger } from "../../utils/logger";
import { deleteFromArchiveSystem7z } from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";
import { selectEngine } from "../../engines/select-engine";
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
  const { engine } = selectEngine({ op: "delete", ext, password });

  // Wrapped formats always mutate via WASM (worker).
  if (engine === "worker" && isWrappedFormat(ext)) {
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
  if (engine === "rarRebuild") {
    logger.info({
      event: "deleteFromArchive.rar5.rebuild",
      archivePath,
      ext,
      count: selectedPaths.length,
    });
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

  // System 7z receives passwords via stdin (never argv), so encrypted
  // archives can safely use the native fast path.
  if (engine === "system7z") {
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
