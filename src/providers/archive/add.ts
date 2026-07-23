/**
 * Archive add operations — Smart Archive VSCode Extension
 *
 * @module providers/archive/add
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { JS7zInstance } from "../../types";
import { JS7z, disposeJS7z } from "../fileListing";
import { streamToVFS } from "../../engines/vfs-io";
import { getFullExt, isWrappedFormat } from "../../constants";
import { checkFileSize, validatePassword } from "../../utils/security";
import { getBaseName } from "../../utils/path";
import { logger } from "../../utils/logger";
import { t } from "../../i18n";
import { withWrappedArchive } from "./wrappedHelper";
import { prepareExclusions, isPathExcluded, type ExclusionSet } from "../../utils/exclude";
import { COMPRESS_EXCLUDE_DEFAULTS } from "../../constants";
import { hasSystem7zForFormat, addToArchiveSystem7z } from "../../engines/system7z";

// ── Per-archive pending state for add-to-archive ──

interface PendingAddState {
  archivePath: string;
  targetDir: string;
  password: string | undefined;
  webview: vscode.Webview | null;
  archiveUri: vscode.Uri | null;
  onComplete?: (webview: vscode.Webview, archiveUri: vscode.Uri, toast?: string) => Promise<void>;
}

const pendingAdds = new Map<string, PendingAddState>();

export function initAddToArchive(
  archivePath: string,
  targetDir: string,
  password: string | undefined,
  webview: vscode.Webview | null,
  archiveUri: vscode.Uri | null,
  onComplete?: (webview: vscode.Webview, archiveUri: vscode.Uri, toast?: string) => Promise<void>,
): void {
  const prev = pendingAdds.get(archivePath);
  if (prev) {
    logger.warn(
      { event: "addToArchive.init.overwritten", prevArchive: archivePath },
      "Pending add state overwritten — previous request was never executed",
    );
    prev.webview?.postMessage({ c: "loading", t: false });
  }
  pendingAdds.set(archivePath, {
    archivePath,
    targetDir,
    password,
    webview,
    archiveUri,
    onComplete,
  });
}

export async function runAddToArchive(): Promise<void> {
  const entries = [...pendingAdds.entries()];
  if (entries.length === 0) {
    logger.warn(
      { event: "addToArchive.run.noCtx" },
      "runAddToArchive called without pending state",
    );
    return;
  }
  const firstKey = entries[0][0];
  const ctx = pendingAdds.get(firstKey)!;
  pendingAdds.delete(firstKey);

  try {
    ctx.webview?.postMessage({ c: "loading", t: true });

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: `$(new-file) ${t("addToArchive.addFiles")}`,
          desc: "files",
          description: t("addToArchive.addFilesDesc"),
        },
        {
          label: `$(new-folder) ${t("addToArchive.addFolders")}`,
          desc: "folders",
          description: t("addToArchive.addFoldersDesc"),
        },
        {
          label: `$(files) ${t("addToArchive.addBoth")}`,
          desc: "both",
          description: t("addToArchive.addBothDesc"),
        },
      ],
      { placeHolder: t("addToArchive.chooseWhat") },
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
        openLabel: pick.desc === "both" ? t("addToArchive.selectFiles") : t("addToArchive.select"),
      });
      if (furis) uris.push(...furis);
    }

    if (pick.desc === "folders" || pick.desc === "both") {
      const duris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel:
          pick.desc === "both" ? t("addToArchive.selectFolders") : t("addToArchive.select"),
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

  const patterns =
    vscode.workspace.getConfiguration("smart-archive").get<string[]>("compressExcludePatterns") ??
    COMPRESS_EXCLUDE_DEFAULTS;
  const exclusions = prepareExclusions(patterns);

  if (isWrappedFormat(ext)) {
    logger.info({ event: "addToArchive.wrapped", archivePath, ext });
    return addToWrappedArchive(archivePath, localPaths, targetDir, password, exclusions);
  }

  // System 7z passes passwords via -p<password> on the command line,
  // visible in process listings. For encrypted archives, fall back to
  // WASM to avoid CLI password leakage.
  if (hasSystem7zForFormat(ext) && !password) {
    logger.info({ event: "addToArchive.system7z", archivePath, ext });
    await addToArchiveSystem7z(archivePath, localPaths, targetDir, exclusions, password);
    return;
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const archiveFsPath = streamToVFS(js7z, archivePath);

    const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(js7z, localPaths, targetDir, exclusions);

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

    const updated = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));

    logger.info({
      event: "addToArchive.ok",
      archivePath,
      files: localPaths.length,
      targetDir,
    });
  } finally {
    disposeJS7z(js7z);
  }
}

async function addToWrappedArchive(
  archivePath: string,
  localPaths: string[],
  targetDir: string,
  password?: string,
  exclusions?: ExclusionSet,
): Promise<void> {
  return withWrappedArchive(archivePath, password, async (js7z2) => {
    const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(js7z2, localPaths, targetDir, exclusions);

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
  exclusions?: ExclusionSet,
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
    if (exclusions && isPathExcluded(name, exclusions)) {
      logger.info({ event: "addToArchive.skipExcluded", path: localPath, name });
      continue;
    }
    const vfsTarget = vfsBase ? `${vfsBase}/${name}` : `/${name}`;
    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      js7z.FS.mkdir(vfsTarget);
      copyDirToFSRecursive(js7z, localPath, vfsTarget, exclusions);
    } else {
      streamToVFS(js7z, localPath, vfsTarget);
    }
    vfsPaths.push(vfsTarget);
  }
  return { vfsPaths, vfsDir };
}

function copyDirToFSRecursive(
  js7z: JS7zInstance,
  localDir: string,
  vfsDir: string,
  exclusions?: ExclusionSet,
): void {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    if (exclusions && isPathExcluded(entry.name, exclusions)) {
      logger.info({
        event: "addToArchive.skipExcludedRecursive",
        name: entry.name,
        dir: localDir,
      });
      continue;
    }
    const localEntry = path.join(localDir, entry.name);
    const vfsEntry = `${vfsDir}/${entry.name}`;
    if (entry.isDirectory()) {
      js7z.FS.mkdir(vfsEntry);
      copyDirToFSRecursive(js7z, localEntry, vfsEntry, exclusions);
    } else {
      streamToVFS(js7z, localEntry, vfsEntry);
    }
  }
}
