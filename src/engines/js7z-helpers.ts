/**
 * js7z helpers — Smart Archiver VSCode Extension
 *
 * Shared infrastructure for the bundled 7zz WASM engine: cleanup, virtual-FS I/O,
 * and the generic 7z command runner with progress reporting.
 *
 * @module engines/js7z-helpers
 */

import * as fs from "fs";

import type { JS7zInstance } from "../types";
import { getBaseName, joinFSPath } from "../utils/path";
import { copyDirToFS } from "../utils/fs";
import type { ExclusionSet } from "../utils/exclude";
import { t } from "../i18n";
import { RUN7Z_TIMEOUT, MEMORY_CHECK_EVERY_PRINT } from "../constants";
import { logger } from "../utils/logger-core";
import { CancelledError } from "../utils/cancellation";
import type { TokenLike, ProgressLike } from "../utils/cancellation";
import { copyToVFS } from "./vfs-io";
import { checkWorkerMemory } from "./worker/memory-guard";

// Canonical cleanup re-exported from the pool module for convenience
export { disposeJS7z } from "./js7z-lifecycle";

const INPUT_DIR = "/in";
const OUTPUT_DIR = "/out";

function copyInputsToFS(
  js7z: JS7zInstance,
  localPaths: readonly string[],
  token?: TokenLike,
  onProgress?: (cumulativeBytes: number) => void,
  exclusions?: ExclusionSet,
): string[] {
  const fsPaths: string[] = [];
  let offset = 0;
  for (const localPath of localPaths) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const name = getBaseName(localPath);
    const fsTarget = joinFSPath(INPUT_DIR, name);
    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      js7z.FS.mkdir(fsTarget);
      offset += copyDirToFS(js7z, localPath, fsTarget, token, onProgress, offset, exclusions);
    } else {
      offset += copyToVFS(js7z, localPath, fsTarget, onProgress, offset);
    }
    fsPaths.push(fsTarget);
  }
  return fsPaths;
}

function sanitizeArgs(args: string[]): string[] {
  return args.map((a) => (/^-p.+/.test(a) ? "-p***" : a));
}

/**
 * Construction-time stdout bridge for the WASM 7z engine.
 *
 * The factory accepts construction-time handlers and also supports assigning
 * `js7z.print` / `js7z.printErr` afterwards — both route to the active
 * callbacks. Pass these handlers into `JS7z({ print, printErr })` and let
 * `run7z` point `bridge.progress` at the active reporter while running.
 */
export interface PrintBridge {
  progress?: ProgressLike;
  print: (text: string) => void;
  printErr: (text: string) => void;
}

export function createPrintBridge(): PrintBridge {
  let lastPct = -1;
  let printCount = 0;
  const handle = (text: string): void => {
    if (++printCount % MEMORY_CHECK_EVERY_PRINT === 0) checkWorkerMemory();
    if (!bridge.progress) return;
    const m = text.match(/(\d{1,3})%/);
    if (m) {
      const pct = parseInt(m[1], 10);
      if (pct !== lastPct && pct > 0) {
        const delta = pct - (lastPct < 0 ? 0 : lastPct);
        lastPct = pct;
        bridge.progress.report({ message: `${pct}%`, increment: delta });
      }
    }
  };
  const bridge: PrintBridge = {
    print: handle,
    // 7zz sends its progress bar to stderr (-bsp2); parse it like stdout.
    printErr: handle,
  };
  return bridge;
}

function run7z(
  js7z: JS7zInstance,
  args: string[],
  progress?: ProgressLike,
  onStdout?: (text: string) => void,
  timeoutMs = RUN7Z_TIMEOUT,
  printBridge?: PrintBridge,
): Promise<void> {
  logger.info({ event: "run7z.start", args: sanitizeArgs(args) });
  // Track cumulative reported percentage so fast/small operations still land
  // on 100% at completion even when no intermediate % is printed.
  let reportedPct = 0;
  const trackProgress: ProgressLike | undefined = progress
    ? {
        report(r) {
          if (typeof r.increment === "number" && r.increment > 0) {
            reportedPct = Math.min(100, reportedPct + r.increment);
          }
          progress.report(r);
        },
      }
    : undefined;
  if (printBridge) printBridge.progress = trackProgress;
  const prevPrint = js7z.print;
  const prevPrintErr = js7z.printErr;
  let stderr = "";
  let lastPct = -1;
  let printCount = 0;
  if (!printBridge) {
    js7z.print = (text: string) => {
      if (onStdout) onStdout(text);
      // RSS guard: check every ~10th print tick (7z prints steadily while
      // working). Throws synchronously — caught by the callMain try/catch.
      if (++printCount % MEMORY_CHECK_EVERY_PRINT === 0) checkWorkerMemory();
      const m = text.match(/(\d{1,3})%/);
      if (m && trackProgress) {
        const pct = parseInt(m[1], 10);
        if (pct !== lastPct && pct > 0) {
          const delta = pct - (lastPct < 0 ? 0 : lastPct);
          lastPct = pct;
          trackProgress.report({ message: `${pct}%`, increment: delta });
        }
      }
    };
    js7z.printErr = (text: string) => {
      stderr += text + "\n";
      // 7zz sends progress to stderr via -bsp2; keep reporting it live.
      if (++printCount % MEMORY_CHECK_EVERY_PRINT === 0) checkWorkerMemory();
      const m = text.match(/(\d{1,3})%/);
      if (m && trackProgress) {
        const pct = parseInt(m[1], 10);
        if (pct !== lastPct && pct > 0) {
          const delta = pct - (lastPct < 0 ? 0 : lastPct);
          lastPct = pct;
          trackProgress.report({ message: `${pct}%`, increment: delta });
        }
      }
    };
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (printBridge) printBridge.progress = undefined;
      if (!printBridge) {
        js7z.print = prevPrint;
        js7z.printErr = prevPrintErr;
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        logger.warn({ event: "run7z.timeout", timeoutMs }, "WASM 7z operation timed out");
        reject(new Error(`7z operation timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    js7z.onExit = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      logger.info({ event: "run7z.done", exitCode });
      if (exitCode === 0) {
        if (trackProgress && reportedPct < 100) {
          trackProgress.report({ message: "100%", increment: 100 - reportedPct });
        }
        resolve();
      } else if (exitCode === 1) {
        // 7-Zip exit code 1 = Warning (Non fatal error).
        // Match system7z.ts behaviour: resolve rather than reject.
        if (trackProgress && reportedPct < 100) {
          trackProgress.report({ message: "100%", increment: 100 - reportedPct });
        }
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
      // -bsp2: the ZS wasm build only emits its progress bar on stderr.
      js7z.callMain(["-bsp2", ...args]);
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
