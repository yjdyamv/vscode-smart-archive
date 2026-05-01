/**
 * Archive operations — Smart Archive VSCode Extension
 *
 * Archive mutation and inspection operations triggered from the webview:
 * delete files, add files, preview a single file, and integrity test.
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
import { getBaseName } from "../utils/path";
import { logger } from "../utils/logger";

// ── Module-level state for add-to-archive ──

let _pendingAdd: {
  archivePath: string;
  targetDir: string;
  password: string | undefined;
  webview: vscode.Webview | null;
  archiveUri: vscode.Uri | null;
} | null = null;

export function initAddToArchive(
  archivePath: string,
  targetDir: string,
  password: string | undefined,
  webview: vscode.Webview | null,
  archiveUri: vscode.Uri | null,
): void {
  _pendingAdd = { archivePath, targetDir, password, webview, archiveUri };
}

export async function runAddToArchive(): Promise<void> {
  const ctx = _pendingAdd;
  _pendingAdd = null;
  if (!ctx) {
    logger.warn({ event: "addToArchive.run.noCtx" }, "runAddToArchive called without pending state");
    return;
  }

  try {
    ctx.webview?.postMessage({ c: "loading", t: true });

    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(new-file) Add Files", desc: "files", description: "Select individual files" },
        { label: "$(new-folder) Add Folders", desc: "folders", description: "Select whole folders" },
        { label: "$(files) Add Both", desc: "both", description: "Select files then folders" },
      ],
      { placeHolder: "Choose what to add to the archive" },
    );
    if (!pick) {
      logger.info({ event: "addToArchive.cancelled", phase: "quickPick" });
      return;
    }

    const uris: vscode.Uri[] = [];

    if (pick.desc === "files" || pick.desc === "both") {
      const furis = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: pick.desc === "both" ? "Select Files" : "Select",
      });
      if (furis) uris.push(...furis);
    }

    if (pick.desc === "folders" || pick.desc === "both") {
      const duris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: pick.desc === "both" ? "Select Folders" : "Select",
      });
      if (duris) uris.push(...duris);
    }

    if (uris.length === 0) {
      logger.info({ event: "addToArchive.cancelled", phase: "fileDialog" });
      return;
    }

    const filePaths = uris.map((u) => u.fsPath);
    logger.info({
      event: "addToArchive.start",
      archivePath: ctx.archivePath,
      files: filePaths.length,
      targetDir: ctx.targetDir,
      sample: filePaths.slice(0, 3).join(", "),
    });

    const start = Date.now();
    await addToArchive(ctx.archivePath, filePaths, ctx.targetDir, ctx.password);
    logger.info({
      event: "addToArchive.complete",
      durationMs: Date.now() - start,
      archivePath: ctx.archivePath,
    });

    if (ctx.webview) ctx.webview.postMessage({ c: "del-ok", t: "done" });
    if (ctx.webview && ctx.archiveUri) {
      const { setupWebview } = require("./webviewHandler") as {
        setupWebview: (w: vscode.Webview, u: vscode.Uri) => Promise<void>;
      };
      await setupWebview(ctx.webview, ctx.archiveUri);
    }
  } catch (err) {
    if (ctx.webview) ctx.webview.postMessage({ c: "err", t: (err as Error).message });
  } finally {
    ctx.webview?.postMessage({ c: "loading", t: false });
  }
}

async function deleteFromArchive(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);

  if (isWrappedFormat(ext)) {
    logger.info({ event: "deleteFromArchive.wrapped", archivePath, ext });
    return deleteFromWrappedArchive(archivePath, selectedPaths, password);
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  logger.info({
    event: "deleteFromArchive.start",
    archivePath,
    sizeBytes: stat.size,
    items: selectedPaths.length,
    sample: selectedPaths.slice(0, 3).join(", "),
  });

  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    const dArgs = ["d", `/${archiveName}`, "-y"];
    if (password) dArgs.splice(1, 0, `-p${password}`);
    dArgs.push(...selectedPaths.map((p) => p.replace(/\\/g, "/")));
    logger.debug({ event: "deleteFromArchive.7zArgs", args: dArgs.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d: ${c}`)));
      js7z.callMain(dArgs);
    });

    const updated = js7z.FS.readFile(`/${archiveName}`, { encoding: "binary" });
    logger.info({
      event: "deleteFromArchive.ok",
      archivePath,
      items: selectedPaths.length,
      newSizeBytes: updated.byteLength,
    });
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

/**
 * Add local files/folders to an existing archive at the specified path.
 *
 * @param archivePath - Path to the archive file on disk
 * @param localPaths - Local file/folder paths to add
 * @param targetDir - Target directory inside the archive (empty = root)
 * @param password - Archive password if encrypted
 */
async function addToArchive(
  archivePath: string,
  localPaths: string[],
  targetDir: string,
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);

  if (isWrappedFormat(ext)) {
    logger.info({ event: "addToArchive.wrapped", archivePath, ext });
    return addToWrappedArchive(archivePath, localPaths, targetDir, password);
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  logger.info({
    event: "addToArchive.readArchive",
    archivePath,
    sizeBytes: stat.size,
    files: localPaths.length,
    targetDir,
  });

  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);

    // Copy local files into VFS
    const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(js7z, localPaths, targetDir);

    // Build 7z args: use directory form when targetDir is set (preserves path),
    // individual file paths otherwise (root-level)
    const args = vfsDir
      ? ["a", `/${archiveName}`, "-aot", vfsDir]
      : ["a", `/${archiveName}`, "-aot", ...vfsPaths];
    if (password) args.splice(1, 0, `-p${password}`);

    logger.debug({ event: "addToArchive.7zArgs", args: args.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
      js7z.callMain(args);
    });

    const updated = js7z.FS.readFile(`/${archiveName}`, { encoding: "binary" });
    logger.debug({ event: "addToArchive.writeResult", newSizeBytes: updated.byteLength });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));

    logger.info({
      event: "addToArchive.ok",
      archivePath,
      files: localPaths.length,
      targetDir,
    });
  } finally {
    tryCleanupJS7z(js7z);
  }
}

async function addToWrappedArchive(
  archivePath: string,
  localPaths: string[],
  targetDir: string,
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    js7z.FS.mkdir("/_aw1");

    // Step 1: Extract outer compression layer
    const xArgs = ["x", `/${archiveName}`, "-o/_aw1", "-y"];
    if (password) xArgs.splice(1, 0, `-p${password}`);
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x: ${c}`)));
      js7z.callMain(xArgs);
    });

    const top = js7z.FS.readdir("/_aw1").filter((e: string) => e !== "." && e !== "..");
    const innerTar = top.find((e: string) => e.endsWith(".tar"));
    if (!innerTar) throw new Error("Wrapped archive: no inner .tar found");

    const innerData = js7z.FS.readFile(`/_aw1/${innerTar}`, { encoding: "binary" });
    const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      js7z2.FS.writeFile("/_inner.tar", new Uint8Array(innerData));

      // Step 2: Copy local files into VFS and add to inner tar
      const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(js7z2, localPaths, targetDir);

      const aArgs = vfsDir
        ? ["a", "/_inner.tar", "-aot", vfsDir]
        : ["a", "/_inner.tar", "-aot", ...vfsPaths];
      if (password) aArgs.splice(1, 0, `-p${password}`);

      await new Promise<void>((resolve, reject) => {
        js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a inner: ${c}`)));
        js7z2.callMain(aArgs);
      });

      const modifiedTar = js7z2.FS.readFile("/_inner.tar", { encoding: "binary" });
      const wrapExt = getWrapExtension(ext);

      // Step 3: Recompress
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

      logger.info({
        event: "addToArchive.wrapped.ok",
        archivePath,
        files: localPaths.length,
        targetDir,
      });
    } finally {
      tryCleanupJS7z(js7z2);
    }
  } finally {
    tryCleanupJS7z(js7z);
  }
}

/**
 * Copy local file/folder paths into the JS7z virtual FS.
 * Returns individual VFS paths and the top-level VFS directory (first component).
 *
 * Strategy (matching j7zCompressDir):
 *   - targetDir non-empty → files at /<targetDir>/<name>, pass first-level dir /<first>
 *   - targetDir empty     → files at /<name>, pass individual file paths
 * Passing the first-level directory preserves the full nested structure;
 * individual paths lose the common prefix.
 */
function copyLocalToFSWithPrefix(
  js7z: JS7zInstance,
  localPaths: string[],
  targetDir: string,
): { vfsPaths: string[]; vfsDir: string | null } {
  const normDir = targetDir.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normDir ? normDir.split("/").filter(Boolean) : [];
  const firstLevel = parts[0] || null;
  const vfsBase = normDir ? `/${normDir}` : "";
  // Pass the first-level directory (like j7zCompressDir) to preserve nested structure
  const vfsDir = firstLevel ? `/${firstLevel}` : null;

  if (normDir) {
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      try { js7z.FS.mkdir(cur); } catch { /* already exists */ }
    }
  }

  const vfsPaths: string[] = [];

  for (const localPath of localPaths) {
    const name = getBaseName(localPath);
    const vfsTarget = vfsBase ? `${vfsBase}/${name}` : `/${name}`;
    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      js7z.FS.mkdir(vfsTarget);
      copyDirToFSRecursive(js7z, localPath, vfsTarget);
    } else {
      const fileData = fs.readFileSync(localPath);
      js7z.FS.writeFile(vfsTarget, fileData);
    }
    vfsPaths.push(vfsTarget);
  }
  return { vfsPaths, vfsDir };
}

function copyDirToFSRecursive(
  js7z: JS7zInstance,
  localDir: string,
  vfsDir: string,
): void {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localEntry = path.join(localDir, entry.name);
    const vfsEntry = `${vfsDir}/${entry.name}`;
    if (entry.isDirectory()) {
      js7z.FS.mkdir(vfsEntry);
      copyDirToFSRecursive(js7z, localEntry, vfsEntry);
    } else {
      const data = fs.readFileSync(localEntry);
      js7z.FS.writeFile(vfsEntry, data);
    }
  }
}

async function createFolderInArchive(
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
    logger.error({ event: "createFolder.unsupported", ext }, "Create folder not supported for wrapped formats");
    throw new Error("Creating folders in wrapped archives (tar.gz, etc.) is not yet supported.");
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });

  try {
    js7z.FS.writeFile(`/${archiveName}`, data);

    // Create new folder structure in VFS
    const vfsFolder = `/${folderPath}`;
    let cur = "";
    for (const part of folderPath.split("/").filter(Boolean)) {
      cur += "/" + part;
      try { js7z.FS.mkdir(cur); } catch { /* exists */ }
    }
    const keepFile = `${vfsFolder}/.keep`;
    js7z.FS.writeFile(keepFile, new Uint8Array(1));

    // Build add args: use directory form for nested, individual for root-level
    const parts = folderPath.split("/").filter(Boolean);
    const firstLevel = parts[0];
    const args = firstLevel
      ? ["a", `/${archiveName}`, "-aot", `/${firstLevel}`]
      : ["a", `/${archiveName}`, "-aot", keepFile];
    if (password) args.splice(1, 0, `-p${password}`);

    logger.debug({ event: "createFolder.7zAdd", args: args.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
      js7z.callMain(args);
    });

    const updated = js7z.FS.readFile(`/${archiveName}`, { encoding: "binary" });

    // Remove .keep on a fresh instance
    const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      js7z2.FS.writeFile(`/${archiveName}`, new Uint8Array(updated));
      const dArgs = ["d", `/${archiveName}`, "-y", `${folderPath}/.keep`];
      if (password) dArgs.splice(1, 0, `-p${password}`);
      logger.debug({ event: "createFolder.7zDelete", args: dArgs.join(" ") });
      await new Promise<void>((resolve, reject) => {
        js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d keep: ${c}`)));
        js7z2.callMain(dArgs);
      });
      const final = js7z2.FS.readFile(`/${archiveName}`, { encoding: "binary" });
      await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(final));
      logger.info({ event: "createFolder.ok", archivePath, folderPath });
    } finally {
      tryCleanupJS7z(js7z2);
    }
  } finally {
    tryCleanupJS7z(js7z);
  }
}

export { deleteFromArchive, addToArchive, createFolderInArchive, previewFileFromArchive, unwrapAndExtract, testArchive };
