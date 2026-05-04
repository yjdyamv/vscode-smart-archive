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
import { logger } from "../utils/logger";

function tryCleanup(instance: JS7zInstance): void {
  try {
    if (typeof instance.destroy === "function") instance.destroy();
    else if (typeof instance._cleanup === "function") instance._cleanup();
  } catch {
    logger.warn({ event: "js7z.cleanup.failed" }, "Failed to clean up JS7z instance");
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
      streamToVFS(js7z, localPath, fsTarget);
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
  logger.info({ event: "run7z.enter", args });
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
    js7z.onExit = (exitCode: number) => {
      js7z.print = prevPrint;
      js7z.printErr = prevPrintErr;
      logger.info({ event: "run7z.exit", exitCode });
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(t("decompress.exitError", String(exitCode)) + "\n" + stderr));
      }
    };
    js7z.callMain(args);
  });
}

const MAX_BUFFER = 2 * 1024 * 1024 * 1024 - 1;
const CHUNK = 100 * 1024 * 1024;

function streamToVFS(js7z: JS7zInstance, filePath: string, vfsPath?: string): string {
  const stat = fs.statSync(filePath);
  const archiveName = getBaseName(filePath);
  const target = vfsPath ?? `/${archiveName}`;

  if (stat.size <= MAX_BUFFER) {
    const data = fs.readFileSync(filePath);
    js7z.FS.writeFile(target, data);
    return target;
  }

  // Stream in chunks via VFS open/write/close
  const rfd = fs.openSync(filePath, "r");
  try {
    js7z.FS.createDataFile("/", target.replace(/^\//, ""), new Uint8Array(0), true, true, 0o777);
    const vfsStream = js7z.FS.open(target, "w");
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      while (true) {
        const n = fs.readSync(rfd, buf, 0, buf.length, pos);
        if (n === 0) break;
        js7z.FS.write(vfsStream, new Uint8Array(buf.slice(0, n)), 0, n, pos);
        pos += n;
      }
    } finally {
      js7z.FS.close(vfsStream);
    }
  } finally {
    fs.closeSync(rfd);
  }
  return target;
}

export { tryCleanup, INPUT_DIR, OUTPUT_DIR, copyInputsToFS, streamToVFS, run7z, MAX_BUFFER };
