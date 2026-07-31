/**
 * js7z helpers — Smart Archive VSCode Extension
 *
 * Shared infrastructure for js7z-tools: cleanup, virtual-FS I/O,
 * and the generic 7z command runner with progress reporting.
 *
 * @module engines/js7z-helpers
 */

import * as fs from "fs";

import type { JS7zInstance } from "../types";
import { getBaseName, joinFSPath } from "../utils/path";
import { copyDirToFS } from "../utils/fs";
import { t } from "../i18n";
import { logger } from "../utils/logger-core";
import { CancelledError } from "../utils/cancellation";
import type { TokenLike, ProgressLike } from "../utils/cancellation";
import { streamToVFS } from "./vfs-io";

// Canonical cleanup re-exported from the pool module for convenience
export { disposeJS7z } from "./js7z-lifecycle";

const INPUT_DIR = "/in";
const OUTPUT_DIR = "/out";

function copyInputsToFS(
  js7z: JS7zInstance,
  localPaths: readonly string[],
  token?: TokenLike,
): string[] {
  const fsPaths: string[] = [];
  for (const localPath of localPaths) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const name = getBaseName(localPath);
    const fsTarget = joinFSPath(INPUT_DIR, name);
    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      js7z.FS.mkdir(fsTarget);
      copyDirToFS(js7z, localPath, fsTarget, token);
    } else {
      streamToVFS(js7z, localPath, fsTarget);
    }
    fsPaths.push(fsTarget);
  }
  return fsPaths;
}

function sanitizeArgs(args: string[]): string[] {
  return args.map((a) => (/^-p.+/.test(a) ? "-p***" : a));
}

function run7z(
  js7z: JS7zInstance,
  args: string[],
  progress?: ProgressLike,
  onStdout?: (text: string) => void,
  timeoutMs = 600_000, // 10 minutes default
): Promise<void> {
  logger.info({ event: "run7z.enter", args: sanitizeArgs(args) });
  const prevPrint = js7z.print;
  const prevPrintErr = js7z.printErr;
  let stderr = "";
  let lastPct = -1;
  js7z.print = (text: string) => {
    if (onStdout) onStdout(text);
    const m = text.match(/(\d{1,3})%/);
    if (m && progress) {
      const pct = parseInt(m[1], 10);
      if (pct !== lastPct && pct > 0) {
        const delta = pct - (lastPct < 0 ? 0 : lastPct);
        lastPct = pct;
        progress.report({ message: `${pct}%`, increment: delta });
      }
    }
  };
  js7z.printErr = (text: string) => {
    stderr += text + "\n";
  };

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        js7z.print = prevPrint;
        js7z.printErr = prevPrintErr;
        logger.warn({ event: "run7z.timeout", timeoutMs }, "WASM 7z operation timed out");
        reject(new Error(`7z operation timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    js7z.onExit = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      js7z.print = prevPrint;
      js7z.printErr = prevPrintErr;
      logger.info({ event: "run7z.exit", exitCode });
      if (exitCode === 0) {
        resolve();
      } else if (exitCode === 1) {
        // 7-Zip exit code 1 = Warning (Non fatal error).
        // Match system7z.ts behaviour: resolve rather than reject.
        logger.warn(
          { event: "run7z.warning", exitCode, stderrTail: stderr.slice(-200) },
          "7z exited with warning (code 1)",
        );
        resolve();
      } else {
        reject(new Error(t("decompress.exitError", String(exitCode)) + "\n" + stderr));
      }
    };
    try {
      js7z.callMain(args);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.error({ event: "run7z.callMain.failed", err }, "callMain threw synchronously");
      reject(err);
    }
  });
}

export { INPUT_DIR, OUTPUT_DIR, copyInputsToFS, run7z };
