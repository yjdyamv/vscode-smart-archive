/**
 * Archive modify/preview/test operations — Smart Archive VSCode Extension
 *
 * @module providers/archive/modify
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import type { JS7zInstance } from "../../types";
import { JS7z, tryCleanupJS7z } from "../fileListing";
import { getFullExt, isWrappedFormat } from "../../constants";
import { checkFileSize } from "../../utils/security";
import { PREVIEW_TMP_DIR } from "../tempFiles";
import { logger } from "../../utils/logger";
import { withWrappedArchive } from "./wrappedHelper";

export async function createFolderInArchive(
  archivePath: string,
  targetDir: string,
  folderName: string,
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);
  const normDir = targetDir.replace(/\\/g, "/").replace(/^\/+/, "");
  const folderPath = normDir ? `${normDir}/${folderName}` : folderName;

  logger.info({
    event: "createFolder.start",
    archivePath,
    targetDir,
    folderName,
    ext,
  });

  if (isWrappedFormat(ext)) {
    return createFolderInWrappedArchive(archivePath, targetDir, folderName, password);
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });

  try {
    js7z.FS.writeFile(`/${archiveName}`, data);

    const vfsFolder = `/${folderPath}`;
    let cur = "";
    for (const part of folderPath.split("/").filter(Boolean)) {
      cur += "/" + part;
      try {
        js7z.FS.mkdir(cur);
      } catch {
        /* exists */
      }
    }
    const dotfile = `${vfsFolder}/.smartarchive`;
    js7z.FS.writeFile(dotfile, new Uint8Array(1));

    const parts = folderPath.split("/").filter(Boolean);
    const firstLevel = parts[0];
    const args = firstLevel
      ? ["a", `/${archiveName}`, "-aot", `/${firstLevel}`]
      : ["a", `/${archiveName}`, "-aot", dotfile];
    if (password) args.splice(1, 0, `-p${password}`);

    logger.debug({ event: "createFolder.7zAdd", args: args.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
      js7z.callMain(args);
    });

    const updated = js7z.FS.readFile(`/${archiveName}`, { encoding: "binary" });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));
    logger.info({ event: "createFolder.ok", archivePath, folderPath });
  } finally {
    tryCleanupJS7z(js7z);
  }
}

async function createFolderInWrappedArchive(
  archivePath: string,
  targetDir: string,
  folderName: string,
  password?: string,
): Promise<void> {
  const normDir = targetDir.replace(/\\/g, "/").replace(/^\/+/, "");
  const folderPath = normDir ? `${normDir}/${folderName}` : folderName;

  return withWrappedArchive(archivePath, password, async (js7z2) => {
    const vfsFolder = `/${folderPath}`;
    let cur = "";
    for (const part of folderPath.split("/").filter(Boolean)) {
      cur += "/" + part;
      try {
        js7z2.FS.mkdir(cur);
      } catch {
        /* exists */
      }
    }
    const dotfile = `${vfsFolder}/.smartarchive`;
    js7z2.FS.writeFile(dotfile, new Uint8Array(1));

    const parts = folderPath.split("/").filter(Boolean);
    const firstLevel = parts[0];
    const aArgs = firstLevel
      ? ["a", "/inner.tar", "-aot", `/${firstLevel}`]
      : ["a", "/inner.tar", "-aot", dotfile];
    if (password) aArgs.splice(1, 0, `-p${password}`);
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a inner: ${c}`)));
      js7z2.callMain(aArgs);
    });
  });
}

export async function previewFileFromArchive(
  archivePath: string,
  filePath: string,
  password?: string,
): Promise<void> {
  const archiveExt = getFullExt(archivePath);
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  logger.info({
    event: "previewFile.start",
    archivePath,
    file: filePath,
    sizeBytes: stat.size,
  });

  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  const normalizedFile = filePath.replace(/\\/g, "/");

  let fileData: ArrayBuffer;
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    js7z.FS.mkdir("/_pv");

    const xArgs = ["x", `/${archiveName}`, "-o/_pv", "-y"];
    if (password) xArgs.splice(1, 0, `-p${password}`);
    if (!isWrappedFormat(archiveExt)) xArgs.push(normalizedFile);
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x: ${c}`)));
      js7z.callMain(xArgs);
    });

    const top = js7z.FS.readdir("/_pv").filter((e: string) => e !== "." && e !== "..");
    if (top.length === 1 && top[0].endsWith(".tar")) {
      fileData = await unwrapAndExtract(js7z, `/_pv/${top[0]}`, normalizedFile, password);
    } else {
      const vfsPath = `/_pv/${normalizedFile}`;
      try {
        fileData = js7z.FS.readFile(vfsPath, { encoding: "binary" });
      } catch {
        throw new Error(`Preview file not found: ${normalizedFile}`);
      }
    }

    const buf = Buffer.from(fileData);
    fs.mkdirSync(PREVIEW_TMP_DIR, { recursive: true });
    const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const ext = path.extname(normalizedFile);
    const tmpPath = path.join(PREVIEW_TMP_DIR, `${hash}${ext}`);
    if (!fs.existsSync(tmpPath)) {
      fs.writeFileSync(tmpPath, buf);
    }
    const uri = vscode.Uri.file(tmpPath);
    await vscode.commands.executeCommand("vscode.open", uri, {
      preview: true,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
  } finally {
    tryCleanupJS7z(js7z);
  }
}

async function unwrapAndExtract(
  js7z: JS7zInstance,
  tarPath: string,
  target: string,
  password?: string,
): Promise<ArrayBuffer> {
  const tarData = js7z.FS.readFile(tarPath, { encoding: "binary" });
  const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z2.FS.writeFile("/_inner.tar", new Uint8Array(tarData));
    js7z2.FS.mkdir("/_pv2");
    const args = ["x", "/_inner.tar", "-o/_pv2", "-y", target];
    if (password) args.splice(1, 0, `-p${password}`);
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x inner: ${c}`)));
      js7z2.callMain(args);
    });
    const vfsPath = `/_pv2/${target}`;
    return js7z2.FS.readFile(vfsPath, { encoding: "binary" });
  } finally {
    tryCleanupJS7z(js7z2);
  }
}

export { unwrapAndExtract };

export async function testArchive(archivePath: string, password?: string): Promise<string> {
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  let stdout = "";
  const js7z = await JS7z({
    print: (text: string) => {
      stdout += text + "\n";
    },
    printErr: () => {},
  });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    const tArgs = ["t", `/${archiveName}`];
    if (password) tArgs.splice(1, 0, `-p${password}`);
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) =>
        c === 0 ? resolve() : reject(new Error(`7z t: ${c}\n${stdout}`));
      js7z.callMain(tArgs);
    });
    const ok = stdout.includes("Everything is Ok");
    return ok
      ? "Archive integrity test passed"
      : "Test completed with warnings:\n" + stdout.slice(-200);
  } finally {
    tryCleanupJS7z(js7z);
  }
}
