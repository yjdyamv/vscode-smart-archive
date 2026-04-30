/**
 * js7z helpers — Smart Archive VSCode Extension
 *
 * Shared infrastructure for js7z-tools: cleanup, virtual-FS I/O,
 * and the generic 7z command runner with progress reporting.
 *
 * @module engines/js7z-helpers
 */

import * as fs from "fs";
import * as vscode from "vscode";
import type { JS7zInstance } from "../types";
import { getBaseName, joinFSPath } from "../utils/path";
import { copyDirToFS } from "../utils/fs";
import { t } from "../i18n";

function tryCleanup(instance: JS7zInstance): void {
  try {
    if (typeof instance.destroy === "function") instance.destroy();
    else if (typeof instance._cleanup === "function") instance._cleanup();
  } catch {
    /* best-effort cleanup */
  }
}

const INPUT_DIR = "/in";
const OUTPUT_DIR = "/out";

function copyInputsToFS(
  js7z: JS7zInstance,
  localPaths: readonly string[],
  token?: vscode.CancellationToken,
): string[] {
  const fsPaths: string[] = [];
  for (const localPath of localPaths) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    const name = getBaseName(localPath);
    const fsTarget = joinFSPath(INPUT_DIR, name);
    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      js7z.FS.mkdir(fsTarget);
      copyDirToFS(js7z, localPath, fsTarget, token);
    } else {
      const data = fs.readFileSync(localPath);
      js7z.FS.writeFile(fsTarget, data);
    }
    fsPaths.push(fsTarget);
  }
  return fsPaths;
}

function run7z(
  js7z: JS7zInstance,
  args: string[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  onStdout?: (text: string) => void,
): Promise<void> {
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
    js7z.onExit = (exitCode: number) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(t("compress.exitError", String(exitCode)) + "\n" + stderr));
      }
    };
    js7z.callMain(args);
  });
}

export { tryCleanup, INPUT_DIR, OUTPUT_DIR, copyInputsToFS, run7z };
