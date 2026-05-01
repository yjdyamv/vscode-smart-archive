/**
 * Archive operations — Smart Archive VSCode Extension
 *
 * Archive mutation and inspection operations triggered from the webview:
 * delete files, preview a single file, and integrity test.
 *
 * @module providers/archiveOperations
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import type { JS7zInstance } from "../types";
import { JS7z, tryCleanupJS7z } from "./fileListing";
import { getFullExt, isWrappedFormat, getWrapExtension } from "../constants";
import { checkFileSize } from "../utils/security";
import { PREVIEW_TMP_DIR } from "./tempFiles";
import { zstdCompress } from "../engines/zstd-codec";

async function deleteFromArchive(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);

  if (isWrappedFormat(ext)) {
    return deleteFromWrappedArchive(archivePath, selectedPaths, password);
  }

  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    const dArgs = ["d", `/${archiveName}`, "-y"];
    if (password) dArgs.splice(1, 0, `-p${password}`);
    dArgs.push(...selectedPaths.map((p) => p.replace(/\\/g, "/")));
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d: ${c}`)));
      js7z.callMain(dArgs);
    });
    const updated = js7z.FS.readFile(`/${archiveName}`, { encoding: "binary" });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));
  } finally {
    tryCleanupJS7z(js7z);
  }
}

async function deleteFromWrappedArchive(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    js7z.FS.mkdir("/_dw1");

    const xArgs = ["x", `/${archiveName}`, "-o/_dw1", "-y"];
    if (password) xArgs.splice(1, 0, `-p${password}`);
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x: ${c}`)));
      js7z.callMain(xArgs);
    });

    const top = js7z.FS.readdir("/_dw1").filter((e: string) => e !== "." && e !== "..");
    const innerTar = top.find((e: string) => e.endsWith(".tar"));
    if (!innerTar) throw new Error("Wrapped archive: no inner .tar found");

    const innerData = js7z.FS.readFile(`/_dw1/${innerTar}`, { encoding: "binary" });
    const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      js7z2.FS.writeFile("/inner.tar", new Uint8Array(innerData));

      const dArgs = ["d", "/inner.tar", "-y"];
      if (password) dArgs.splice(1, 0, `-p${password}`);
      dArgs.push(...selectedPaths.map((p) => p.replace(/\\/g, "/")));
      await new Promise<void>((resolve, reject) => {
        js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d: ${c}`)));
        js7z2.callMain(dArgs);
      });

      const modifiedTar = js7z2.FS.readFile("/inner.tar", { encoding: "binary" });
      const wrapExt = getWrapExtension(ext);

      let compressedData: Uint8Array;
      if (wrapExt === "zst") {
        compressedData = await zstdCompress(new Uint8Array(modifiedTar), 5);
      } else {
        const js7z3 = await JS7z({ print: () => {}, printErr: () => {} });
        try {
          js7z3.FS.writeFile("/_re.tar", new Uint8Array(modifiedTar));
          const compOut = `/_re.${wrapExt}`;
          const compArgs = ["a", compOut, "/_re.tar"];
          if (password) compArgs.splice(1, 0, `-p${password}`);
          await new Promise<void>((resolve, reject) => {
            js7z3.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
            js7z3.callMain(compArgs);
          });
          compressedData = new Uint8Array(js7z3.FS.readFile(compOut, { encoding: "binary" }));
        } finally {
          tryCleanupJS7z(js7z3);
        }
      }

      await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), compressedData);
    } finally {
      tryCleanupJS7z(js7z2);
    }
  } finally {
    tryCleanupJS7z(js7z);
  }
}

async function previewFileFromArchive(
  archivePath: string,
  filePath: string,
  password?: string,
): Promise<void> {
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  const normalizedFile = filePath.replace(/\\/g, "/");
  const archiveExt = getFullExt(archivePath);

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

async function testArchive(archivePath: string, password?: string): Promise<string> {
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

export { deleteFromArchive, previewFileFromArchive, unwrapAndExtract, testArchive };
