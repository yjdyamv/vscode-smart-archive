/**
 * js7z helpers — Smart Archive VSCode Extension
 *
 * Shared infrastructure for js7z-tools: cleanup, virtual-FS I/O,
 * and the generic 7z command runner with progress reporting.
 *
 * @module engines/js7z-helpers
 */

import * as fs from "fs";
import * as path from "path";
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
      const data = fs.readFileSync(localPath);
      js7z.FS.writeFile(fsTarget, data);
    }
    fsPaths.push(fsTarget);
  }
  return fsPaths;
}

function mountLocalPaths(js7z: JS7zInstance, localPaths: readonly string[]): { paths: string[]; usesMount: boolean; mountedLocalPaths: string[] } {
  const result: string[] = [];
  const mounted: string[] = [];
  let usesMount = false;
  for (const localPath of localPaths) {
    const stat = fs.statSync(localPath);
    const large = stat.isDirectory() ? dirHasLargeFile(localPath) : stat.size > MAX_BUFFER;
    if (large) {
      const name = getBaseName(localPath);
      const parentDir = path.dirname(localPath);
      const mnt = `/mnt_${_mntCount++}`;
      try { js7z.FS.mkdir(mnt); } catch { /* ignore */ }
      js7z.FS.mount(js7z.NODEFS, { root: parentDir }, mnt);
      result.push(`${mnt}/${name}`);
      mounted.push(localPath);
      usesMount = true;
    }
  }
  return { paths: result, usesMount, mountedLocalPaths: mounted };
}

function dirHasLargeFile(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        if (dirHasLargeFile(full)) return true;
      } else if (e.isFile() && fs.statSync(full).size > MAX_BUFFER) {
        return true;
      }
    }
  } catch { /* skip unreadable */ }
  return false;
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

let _mntCount = 0;

function mountArchive(js7z: JS7zInstance, filePath: string): string {
  const stat = fs.statSync(filePath);
  const archiveName = getBaseName(filePath);

  if (stat.size <= MAX_BUFFER) {
    const data = fs.readFileSync(filePath);
    js7z.FS.writeFile(`/${archiveName}`, data);
    return `/${archiveName}`;
  }

  const parentDir = path.dirname(filePath);
  const mnt = `/mnt_${_mntCount++}`;
  try {
    js7z.FS.mkdir(mnt);
  } catch {
    /* already exists */
  }
  js7z.FS.mount(js7z.NODEFS, { root: parentDir }, mnt);
  return `${mnt}/${archiveName}`;
}

async function mutateArchive(
  archivePath: string,
  js7z: JS7zInstance,
  action: (fsPath: string) => Promise<void>,
): Promise<void> {
  const fsPath = mountArchive(js7z, archivePath);
  const usesMount = fsPath.startsWith("/mnt_");
  await action(fsPath);
  if (!usesMount) {
    const updated = js7z.FS.readFile(fsPath, { encoding: "binary" });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));
  }
}

export { tryCleanup, INPUT_DIR, OUTPUT_DIR, copyInputsToFS, mountLocalPaths, run7z, mountArchive, mutateArchive, MAX_BUFFER };
