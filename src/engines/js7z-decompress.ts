/**
 * js7z decompress dispatcher — Smart Archiver VSCode Extension
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
import { decompressWithSystem7z, unwrapInnerTarsWithSystem7z } from "./system7z";
import { selectEngine } from "./select-engine";
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

  // Note: unlike compress, the selector keeps system 7z for encrypted
  // archives here. WASM decompression of password-protected files has
  // a known copyDirFromFS issue (separate bug). The password risk on
  // decompress is the same (CLI exposure), but the user already knows
  // the password — it was just entered — so the window is narrow.
  const { engine, reason } = selectEngine({
    op: "decompress",
    ext: getFullExt(options.inputPath),
    archivePath: options.inputPath,
  });
  logger.info({ event: "decompress.engine", engine, reason });

  if (engine === "system7z") {
    try {
      await decompressWithSystem7z(options, progress, token);
      // Unwrap inner tars with 7-Zip itself so no WASM work remains on this path.
      await unwrapInnerTarsWithSystem7z(
        options.outputDir,
        progress as ProgressLike | undefined,
        token as TokenLike | undefined,
        !!options.allowOversize,
      );
    } catch (err) {
      if (isCancellationError(err)) throw new vscode.CancellationError();
      // Auto mode promises best-effort: a runtime failure of the chosen
      // binary must not surface as a hard error when the WASM worker can
      // still extract. Explicit native/bundled settings keep their chosen
      // binary and surface the failure instead. The worker path re-extracts
      // and merges into outputDir, so a partially-unwrapped directory from
      // the failed system-7z attempt is safe to reuse.
      const setting = vscode.workspace
        .getConfiguration("smart-archiver")
        .get<string>("backend.7z", "auto");
      if (setting !== "auto") throw err;
      logger.warn(
        { event: "decompress.system7z.fallback", err },
        "System 7-Zip decompression failed; retrying with the WASM worker",
      );
      await runArchiveOp(
        "decompress",
        { options },
        progress as ProgressLike | undefined,
        token as TokenLike | undefined,
      );
    }
  } else {
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
}
