/**
 * Archive add operations — Smart Archive VSCode Extension
 *
 * @module providers/archive/add
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { JS7zInstance } from "../../types";
import { JS7z, tryCleanupJS7z } from "../fileListing";
import { mountArchive, dirHasLargeFile, MAX_BUFFER } from "../../engines/js7z-helpers";
import { getFullExt, isWrappedFormat } from "../../constants";
import { checkFileSize, validatePassword } from "../../utils/security";
import { getBaseName } from "../../utils/path";
import { logger } from "../../utils/logger";
import { t } from "../../i18n";
import { withWrappedArchive } from "./wrappedHelper";

// ── Module-level state for add-to-archive ──

let _pendingAdd: {
  archivePath: string;
  targetDir: string;
  password: string | undefined;
  webview: vscode.Webview | null;
  archiveUri: vscode.Uri | null;
  onComplete?: (webview: vscode.Webview, archiveUri: vscode.Uri, toast?: string) => Promise<void>;
} | null = null;

export function initAddToArchive(
  archivePath: string,
  targetDir: string,
  password: string | undefined,
  webview: vscode.Webview | null,
  archiveUri: vscode.Uri | null,
  onComplete?: (webview: vscode.Webview, archiveUri: vscode.Uri, toast?: string) => Promise<void>,
): void {
  _pendingAdd = { archivePath, targetDir, password, webview, archiveUri, onComplete };
}

export async function runAddToArchive(): Promise<void> {
  const ctx = _pendingAdd;
  _pendingAdd = null;
  if (!ctx) {
    logger.warn(
      { event: "addToArchive.run.noCtx" },
      "runAddToArchive called without pending state",
    );
    return;
  }

  try {
    ctx.webview?.postMessage({ c: "loading", t: true });

    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(new-file) Add Files", desc: "files", description: "Select individual files" },
        {
          label: "$(new-folder) Add Folders",
          desc: "folders",
          description: "Select whole folders",
        },
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

    if (ctx.webview && ctx.archiveUri && ctx.onComplete) {
      await ctx.onComplete(ctx.webview, ctx.archiveUri, t("archive.toastAddedFiles"));
    }
  } catch (err) {
    logger.error({ event: "addToArchive.run.failed", err }, "Add to archive failed");
    if (ctx.webview) ctx.webview.postMessage({ c: "err", t: (err as Error).message });
  } finally {
    ctx.webview?.postMessage({ c: "loading", t: false });
  }
}

/**
 * Add local files/folders to an existing archive at the specified path.
 */
export async function addToArchive(
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

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const archiveFsPath = mountArchive(js7z, archivePath);
    const usesMount = archiveFsPath.startsWith("/mnt_");

    const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(js7z, localPaths, targetDir);

    const args = vfsDir
      ? ["a", archiveFsPath, "-aot", vfsDir]
      : ["a", archiveFsPath, "-aot", ...vfsPaths];
    if (password) {
      validatePassword(password);
      args.splice(1, 0, `-p${password}`);
    }

    logger.debug({ event: "addToArchive.7zArgs", args: args.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
      js7z.callMain(args);
    });

    if (!usesMount) {
      const updated = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
      await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));
    }

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
  return withWrappedArchive(archivePath, password, async (js7z2) => {
    const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(js7z2, localPaths, targetDir);

    const aArgs = vfsDir
      ? ["a", "/inner.tar", "-aot", vfsDir]
      : ["a", "/inner.tar", "-aot", ...vfsPaths];
    if (password) {
      validatePassword(password);
      aArgs.splice(1, 0, `-p${password}`);
    }

    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a inner: ${c}`)));
      js7z2.callMain(aArgs);
    });
  });
}

/**
 * Copy local file/folder paths into the JS7z virtual FS.
 * Returns individual VFS paths and the top-level VFS directory (first component).
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
  const vfsDir = firstLevel ? `/${firstLevel}` : null;

  if (normDir) {
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      try {
        js7z.FS.mkdir(cur);
      } catch {
        logger.warn(
          { event: "addToArchive.mkdir.failed" },
          "Failed to create directory in virtual FS",
        );
      }
    }
  }

  const vfsPaths: string[] = [];

    for (const localPath of localPaths) {
      const name = getBaseName(localPath);
      const vfsTarget = vfsBase ? `${vfsBase}/${name}` : `/${name}`;
      const stat = fs.statSync(localPath);

      if ((stat.isFile() && stat.size > MAX_BUFFER) || (stat.isDirectory() && dirHasLargeFile(localPath))) {
        const parentDir = path.dirname(localPath);
        const mnt = `/mnt_add_${Date.now()}`;
        try { js7z.FS.mkdir(mnt); } catch { /* ignore */ }
        js7z.FS.mount(js7z.NODEFS, { root: parentDir }, mnt);
        if (normDir) {
          try { js7z.FS.mkdir("/" + normDir); } catch { /* ignore */ }
        }
        vfsPaths.push(`${mnt}/${name}`);
      } else if (stat.isDirectory()) {
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

function copyDirToFSRecursive(js7z: JS7zInstance, localDir: string, vfsDir: string): void {
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
