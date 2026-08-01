/**
 * js7z compress dispatcher — Smart Archive VSCode Extension
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
import { hasSystem7zForFormat, compressWithSystem7z } from "./system7z";
import { compressWithRar5 } from "./rar5-engine";
import { isCancellationError } from "../utils/cancellation";
import type { TokenLike, ProgressLike } from "../utils/cancellation";
import { logger } from "../utils/logger";

export async function compressWith7z(
  options: CompressOptions,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
  excludePatterns?: string[],
): Promise<void> {
  // RAR5 creation is handled by the native rar5 engine — 7-Zip cannot
  // create RAR archives, and the rar5 binding keeps passwords in memory.
  if (options.format.label === "rar") {
    logger.info({ event: "compress.usingRar5", format: options.format.label });
    try {
      await compressWithRar5(options, progress, token, excludePatterns);
    } catch (err) {
      if (isCancellationError(err)) throw new vscode.CancellationError();
      throw err;
    }
    return;
  }

  // System 7z passes passwords via -p<password> on the command line,
  // which is visible in process listings (ps aux). For encrypted archives,
  // force WASM to avoid CLI password leakage.
  if (hasSystem7zForFormat(options.format.label) && !options.password) {
    logger.info({ event: "compress.usingSystem7z", format: options.format.label });
    await compressWithSystem7z(options, progress, token, excludePatterns);
    return;
  }

  if (options.password) {
    logger.info({ event: "compress.wasm.encrypted", format: options.format.label });
  }
  logger.info({ event: "compress.wasm.fallback", format: options.format.label });

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
