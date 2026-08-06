/**
 * js7z decompress dispatcher — Smart Archive VSCode Extension
 *
 * Host-side entry point for decompression. Keeps the original
 * decompressWith7z signature; the heavy WASM pipeline now runs in a
 * worker_threads worker (js7z-decompress-core + engines/worker).
 * The system-7z fast path (child process) is unchanged.
 *
 * @module engines/js7z-decompress
 */

import * as vscode from "vscode";
import type { DecompressOptions } from "../types";
import { runArchiveOp } from "./worker/runner";
import { hasSystem7zForFormat, decompressWithSystem7z, system7zCanDecompress } from "./system7z";
import { isCancellationError } from "../utils/cancellation";
import type { TokenLike, ProgressLike } from "../utils/cancellation";
import { logger } from "../utils/logger";
import { getFullExt } from "../constants";

export async function decompressWith7z(
  options: DecompressOptions,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  logger.info({
    event: "decompress.start",
    inputPath: options.inputPath,
    outputDir: options.outputDir,
  });

  // Note: unlike compress, we don't skip system 7z for encrypted
  // archives here. WASM decompression of password-protected files has
  // a known copyDirFromFS issue (separate bug). The password risk on
  // decompress is the same (CLI exposure), but the user already knows
  // the password — it was just entered — so the window is narrow.
  const useSystem = hasSystem7zForFormat(getFullExt(options.inputPath), true);
  if (useSystem && system7zCanDecompress(options.inputPath)) {
    logger.info({ event: "decompress.usingSystem7z" });
    await decompressWithSystem7z(options, progress, token);
    // Inner-tar unwrap also runs in the worker — the system-7z fast path
    // must not leave any WASM work on the host thread.
    await runArchiveOp(
      "unwrap",
      { outputDir: options.outputDir },
      progress as ProgressLike | undefined,
      token as TokenLike | undefined,
    );
    return;
  }
  if (useSystem) {
    logger.info({
      event: "decompress.wasm.fallback",
      reason: "system7z-unsupported-methods",
      inputPath: options.inputPath,
    });
  }

  try {
    await runArchiveOp(
      "decompress",
      { options },
      progress as ProgressLike | undefined,
      token as TokenLike | undefined,
    );
  } catch (err) {
    // Preserve vscode.CancellationError semantics for existing callers.
    if (isCancellationError(err)) throw new vscode.CancellationError();
    throw err;
  }
}
