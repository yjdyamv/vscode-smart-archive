/**
 * js7z compress dispatcher — Smart Archiver VSCode Extension
 *
 * Host-side entry point for compression. Keeps the original
 * compressWith7z signature; the heavy WASM pipeline now runs in a
 * worker_threads worker (js7z-compress-core + engines/worker).
 * The system-7z fast path (child process) is unchanged.
 *
 * @module engines/js7z-compress
 */

import * as vscode from "vscode";
import type { CompressOptions } from "../types";
import { runArchiveOp } from "./worker/runner";
import { compressWithSystem7z } from "./system7z";
import { compressWithRar5 } from "./rar5-engine";
import { selectEngine } from "./select-engine";
import { isCancellationError } from "../utils/cancellation";
import type { TokenLike, ProgressLike } from "../utils/cancellation";
import { logger } from "../utils/logger";

export async function compressWith7z(
  options: CompressOptions,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
  excludePatterns?: string[],
): Promise<void> {
  const { engine, reason } = selectEngine({
    op: "compress",
    ext: options.format.label,
    password: options.password,
  });
  logger.info({
    event: "compress.engine",
    engine,
    reason,
    format: options.format.label,
  });

  if (engine === "rar5") {
    try {
      await compressWithRar5(options, progress, token, excludePatterns);
    } catch (err) {
      if (isCancellationError(err)) throw new vscode.CancellationError();
      throw err;
    }
    return;
  }

  if (engine === "system7z") {
    try {
      await compressWithSystem7z(options, progress, token, excludePatterns);
    } catch (err) {
      if (isCancellationError(err)) throw new vscode.CancellationError();
      // Auto mode promises best-effort: a runtime failure of the chosen
      // binary (corrupt binary, missing shared lib, permission issue) must
      // not surface to the user as a hard error when the WASM worker can
      // still do the job. Explicit native/bundled settings keep their
      // chosen binary and surface the failure instead.
      const setting = vscode.workspace
        .getConfiguration("smart-archiver")
        .get<string>("backend.7z", "auto");
      if (setting !== "auto") throw err;
      logger.warn(
        { event: "compress.system7z.fallback", err },
        "System 7-Zip compression failed; retrying with the WASM worker",
      );
      await runArchiveOp(
        "compress",
        { options, excludePatterns },
        progress as ProgressLike | undefined,
        token as TokenLike | undefined,
      );
    }
    return;
  }

  try {
    await runArchiveOp(
      "compress",
      { options, excludePatterns },
      progress as ProgressLike | undefined,
      token as TokenLike | undefined,
    );
  } catch (err) {
    // Preserve vscode.CancellationError semantics for existing callers.
    if (isCancellationError(err)) throw new vscode.CancellationError();
    throw err;
  }
}
