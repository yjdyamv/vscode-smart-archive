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
  const archiveName = getBaseName(filePath);
  const target = vfsPath ?? `/${archiveName}`;

  // For split volumes (archive.7z.001), stream ALL parts so 7z can
  // find .002, .003, etc. in the same VFS directory.
  const splitMatch = filePath.match(/^(.+\.(?:7z|zip|wim))\.(\d+)$/i);
  if (splitMatch) {
    const base = splitMatch[1];
    const dir = path.dirname(base);
    const name = path.basename(base);
    const nameEscaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const partPattern = new RegExp(`^${nameEscaped}\\.(\\d+)$`, "i");

    const parts = fs
      .readdirSync(dir)
      .filter((f) => partPattern.test(f))
      .sort(
        (a, b) => parseInt(a.match(partPattern)![1], 10) - parseInt(b.match(partPattern)![1], 10),
      );

    if (parts.length === 0) {
      throw new Error(
        `No split volume parts found for "${filePath}". Ensure all parts are in the same directory.`,
      );
    }

    for (const partName of parts) {
      const partPath = path.join(dir, partName);
      const partTarget = vfsPath
        ? `${vfsPath.replace(/\.\d+$/, "")}.${partName.match(partPattern)![1]}`
        : `/${partName}`;
      copyToVFS(js7z, partPath, partTarget);
    }

    const first = parts[0];
    return vfsPath
      ? `${vfsPath.replace(/\.\d+$/, "")}.${first.match(partPattern)![1]}`
      : `/${first}`;
  }

  // RAR split volumes: basename.part1.rar, basename.part2.rar, ...
  const rarPartMatch = filePath.match(/^(.+)\.part(\d+)\.rar$/i);
  if (rarPartMatch) {
    const base = rarPartMatch[1];
    const dir = path.dirname(base);
    const fn = path.basename(base);
    const fnEscaped = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const partPattern = new RegExp(`^${fnEscaped}\\.part(\\d+)\\.rar$`, "i");

    const parts = fs
      .readdirSync(dir)
      .filter((f) => partPattern.test(f))
      .sort(
        (a, b) => parseInt(a.match(partPattern)![1], 10) - parseInt(b.match(partPattern)![1], 10),
      );

    for (const partName of parts) {
      const partPath = path.join(dir, partName);
      const partTarget = vfsPath
        ? `${vfsPath.replace(/\.part\d+/, `.part${partName.match(partPattern)![1]}`)}`
        : `/${partName}`;
      copyToVFS(js7z, partPath, partTarget);
    }

    // Also copy the .rar base file if it exists (legacy volume set)
    const rarBase = path.join(dir, `${fn}.rar`);
    if (fs.existsSync(rarBase)) {
      const baseTarget = vfsPath ? vfsPath.replace(/\.part\d+\.rar$/, ".rar") : `/${fn}.rar`;
      copyToVFS(js7z, rarBase, baseTarget);
    }

    const firstNum = parts.length > 0 ? parts[0].match(partPattern)![1] : "1";
    return vfsPath ? vfsPath.replace(/\.part\d+/, `.part${firstNum}`) : `/${fn}.part1.rar`;
  }

  // RAR split volumes: basename.r00, basename.r01, ... + basename.rar
  const rarVolMatch = filePath.match(/^(.+)\.(r(?:ar|\d{2}))$/i);
  if (rarVolMatch && /^r\d{2}$/i.test(rarVolMatch[2])) {
    const baseName = rarVolMatch[1];
    const dir = path.dirname(baseName);
    const fn = path.basename(baseName);
    const fnEscaped = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rnnPattern = new RegExp(`^${fnEscaped}\\.r(\\d{2})$`, "i");

    // Copy the main .rar first
    const rarFile = path.join(dir, `${fn}.rar`);
    if (fs.existsSync(rarFile)) {
      const rarTarget = vfsPath ? vfsPath.replace(/\.r\d{2}$/, ".rar") : `/${fn}.rar`;
      copyToVFS(js7z, rarFile, rarTarget);
    }

    const parts = fs
      .readdirSync(dir)
      .filter((f) => rnnPattern.test(f))
      .sort(
        (a, b) => parseInt(a.match(rnnPattern)![1], 10) - parseInt(b.match(rnnPattern)![1], 10),
      );

    for (const partName of parts) {
      const partPath = path.join(dir, partName);
      const partTarget = vfsPath
        ? vfsPath.replace(/\.r\d{2}$/, `.r${partName.match(rnnPattern)![1]}`)
        : `/${partName}`;
      copyToVFS(js7z, partPath, partTarget);
    }

    return vfsPath ? vfsPath.replace(/\.r\d{2}$/, ".rar") : `/${fn}.rar`;
  }

  copyToVFS(js7z, filePath, target);
  return target;
}

function copyToVFS(js7z: JS7zInstance, filePath: string, vfsPath: string): void {
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_BUFFER) {
    const data = fs.readFileSync(filePath);
    js7z.FS.writeFile(vfsPath, data);
    return;
  }

  // Stream in chunks via VFS open/write/close
  const rfd = fs.openSync(filePath, "r");
  try {
    js7z.FS.createDataFile("/", vfsPath.replace(/^\//, ""), new Uint8Array(0), true, true, 0o777);
    const vfsStream = js7z.FS.open(vfsPath, "w");
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
}

export { tryCleanup, INPUT_DIR, OUTPUT_DIR, copyInputsToFS, streamToVFS, run7z, MAX_BUFFER };
