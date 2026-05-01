/**
 * Webview handler — Smart Archive VSCode Extension
 *
 * Core orchestration for archive webviews: state management, file listing,
 * encrypted archive password flow, and webview message dispatch.
 * Shared between the custom editor provider and the standalone browse command.
 *
 * @module providers/webviewHandler
 */

import * as vscode from "vscode";
import * as path from "path";
import { isEncrypted } from "../engines/js7z-engine";
import { getFullExt, isWrappedFormat, isEncryptableExt } from "../constants";
import { isRarVolume, resolveRarVolume } from "../utils/rar";
import { logger } from "../utils/logger";
import { t, formatCompactSize } from "../i18n";
import { buildTree, countTreeStats } from "./treeBuilder";
import { loadingHtml, emptyHtml, passwordHtml, contentHtml } from "./htmlRenderer";
import { JS7z, tryCleanupJS7z, fetchFileList } from "./fileListing";
import { extractSelected } from "./extraction";
import {
  createFolderInArchive,
  deleteFromArchive,
  initAddToArchive,
  previewFileFromArchive,
  testArchive,
} from "./archive";
import { setCopiedPaths } from "./copyPaste";

const EXT_ID = "yjdyamv.smart-archive";

function showErrorWithCopy(msg: string): void {
  vscode.window.showErrorMessage(msg, "Copy").then((action) => {
    if (action === "Copy") vscode.env.clipboard.writeText(msg);
  });
}

interface HandlerState {
  archiveUri: vscode.Uri;
  archiveName: string;
  filePath: string;
  password: string | undefined;
}

const handlerStates = new WeakMap<vscode.Webview, HandlerState>();
const handlerRegistered = new WeakSet<vscode.Webview>();

function getWebviewUris(webview: vscode.Webview): { cssUri: string; jsUri: string } {
  const extUri = vscode.extensions.getExtension(EXT_ID)!.extensionUri;
  return {
    cssUri: webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "preview.css")).toString(),
    jsUri: webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "preview.js")).toString(),
  };
}

async function setupWebview(webview: vscode.Webview, archiveUri: vscode.Uri): Promise<void> {
  let filePath = archiveUri.fsPath;
  const ext = getFullExt(filePath);
  const { cssUri, jsUri } = getWebviewUris(webview);

  if (isRarVolume(ext)) {
    const rarPath = resolveRarVolume(filePath);
    if (rarPath) {
      filePath = rarPath;
    } else {
      webview.html = emptyHtml(
        `Multi-volume RAR: "${path.basename(filePath)}" requires a .rar file in the same directory.`,
        cssUri,
        jsUri,
      );
      return;
    }
  }

  const archiveName = path.basename(filePath);
  logger.info({
    event: "setupWebview.start",
    filePath,
    ext,
    wrapped: isWrappedFormat(getFullExt(filePath)),
  });

  webview.html = loadingHtml();

  let entries: { path: string; size: number; type: string }[];
  try {
    entries = await fetchFileList(filePath);
  } catch (err) {
    logger.error({ event: "setupWebview.fetchFileList.failed", err }, (err as Error).message);
    webview.html = emptyHtml(t("decompress.failed") + (err as Error).message, cssUri, jsUri);
    return;
  }

  const prev = handlerStates.get(webview);

  if (isEncryptableExt(getFullExt(filePath))) {
    let encrypted = false;
    if (entries.length === 0) {
      try {
        encrypted = await isEncrypted(filePath);
      } catch {
        /* can't detect — treat as encrypted to be safe */
        encrypted = true;
      }
    }

    logger.info({ event: "setupWebview.encrypted", encrypted });

    if (encrypted && prev?.password) {
      logger.info({ event: "setupWebview.password.retry" });
      try {
        const pwEntries = await fetchFileList(filePath, prev.password);
        if (pwEntries.length > 0) {
          entries = pwEntries;
          encrypted = false;
          logger.info({ event: "setupWebview.password.retrySuccess", count: pwEntries.length });
        }
      } catch {
        logger.warn({ event: "setupWebview.password.retryFailed" });
      }
    }

    if (encrypted) {
      logger.info({ event: "setupWebview.passwordRequired" });
      handlerStates.set(webview, {
        archiveUri,
        archiveName,
        filePath,
        password: prev?.password,
      });
      webview.html = passwordHtml(archiveName, cssUri);
      if (!handlerRegistered.has(webview)) {
        handlerRegistered.add(webview);
        registerHandler(webview);
      }
      return;
    }
  }

  logger.info({ event: "setupWebview.entries", count: entries.length });

  handlerStates.set(webview, {
    archiveUri,
    archiveName,
    filePath,
    password: prev?.password,
  });
  const tree = buildTree(entries, archiveName);
  const stats = countTreeStats(tree);
  const fileCount = stats.files;
  const dirCount = stats.dirs;
  const itemCount = stats.total;
  const totalSize = entries.reduce((s, e) => s + (e.size || 0), 0);
  webview.html = contentHtml(tree, fileCount, dirCount, cssUri, jsUri, {
    name: archiveName,
    format: ext,
    count: itemCount,
    size: formatCompactSize(totalSize),
  });

  if (!handlerRegistered.has(webview)) {
    handlerRegistered.add(webview);
    registerHandler(webview);
  }
}

function registerHandler(webview: vscode.Webview): void {
  webview.onDidReceiveMessage(
    async (msg: {
      c: string;
      paths?: string[];
      msg?: string;
      flat?: boolean;
      path?: string;
      dir?: string;
      name?: string;
      pw?: string;
    }) => {
      logger.info({ event: "webview.msg", c: msg.c, dir: msg.dir });
      const s = handlerStates.get(webview);
      if (!s) return;

      if (msg.c === "log") {
        logger.debug({ event: "webview.ui", msg: msg.msg });
        return;
      }

      const { cssUri, jsUri } = getWebviewUris(webview);

      // ── Password submit (encrypted archives) ──
      if (msg.c === "pw" && msg.pw) {
        logger.info({ event: "webview.password.attempt" });
        try {
          const data = await vscode.workspace.fs.readFile(vscode.Uri.file(s.filePath));
          const pwEntries = await fetchFileList(s.filePath, msg.pw, new Uint8Array(data));
          if (pwEntries.length === 0) {
            webview.postMessage({ c: "pwerr", t: "Wrong password" });
            return;
          }
          const js7z = await JS7z({ print: () => {}, printErr: () => {} });
          try {
            js7z.FS.writeFile("/_pwtest", new Uint8Array(data));
            await new Promise<void>((resolve, reject) => {
              js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z t: ${c}`)));
              js7z.callMain(["t", `-p${msg.pw}`, "/_pwtest"]);
            });
          } catch {
            webview.postMessage({ c: "pwerr", t: "Wrong password" });
            return;
          } finally {
            tryCleanupJS7z(js7z);
          }
          logger.info({ event: "webview.password.ok", count: pwEntries.length });
          s.password = msg.pw;
          const tree = buildTree(pwEntries, s.archiveName);
          const stats = countTreeStats(tree);
          const fc = stats.files;
          const dc = stats.dirs;
          const itemCount = stats.total;
          const totalSize = pwEntries.reduce((sum, e) => sum + (e.size || 0), 0);
          const ext = getFullExt(s.filePath);
          webview.html = contentHtml(tree, fc, dc, cssUri, jsUri, {
            name: s.archiveName,
            format: ext,
            count: itemCount,
            size: formatCompactSize(totalSize),
          });
        } catch (err) {
          logger.error({ event: "webview.password.error", err });
          webview.postMessage({ c: "pwerr", t: "Wrong password" });
        }
        return;
      }

      // ── Skip password (open without unlocking) ──
      if (msg.c === "skipPw") {
        logger.info({ event: "webview.skipPw", archiveName: s.archiveName });
        webview.html = contentHtml([], 0, 0, cssUri, jsUri);
        return;
      }

      // ── Extract All ──
      if (msg.c === "extAll") {
        logger.info({ event: "webview.extAll", archiveName: s.archiveName });
        try {
          await vscode.commands.executeCommand("yjdyamv.smart-archive.decompress", s.archiveUri);
          webview.postMessage({ c: "ok", t: t("decompress.done") + s.archiveName });
        } catch (err) {
          logger.error({ event: "webview.extAll.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        }
      }

      // ── Extract Selected ──
      if (msg.c === "extSel" && Array.isArray(msg.paths) && msg.paths.length > 0) {
        logger.info({ event: "webview.extSel", count: msg.paths.length, first: msg.paths[0] });
        try {
          await extractSelected(s.filePath, msg.paths, s.password, msg.flat);
          webview.postMessage({ c: "ok", t: t("decompress.done") + s.archiveName });
        } catch (err) {
          logger.error({ event: "webview.extSel.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        }
      }

      // ── Copy ──
      if (msg.c === "copy" && Array.isArray(msg.paths) && msg.paths.length > 0) {
        setCopiedPaths(msg.paths, s.filePath, s.password, msg.flat);
        logger.info({ event: "webview.copy", count: msg.paths.length, flat: msg.flat });
        vscode.window.showInformationMessage(t("archive.copied", String(msg.paths.length)));
        vscode.commands.executeCommand("yjdyamv.smart-archive.paste");
      }

      // ── Delete ──
      if (msg.c === "delSel" && Array.isArray(msg.paths) && msg.paths.length > 0) {
        logger.info({ event: "webview.delSel", count: msg.paths.length, first: msg.paths[0] });
        try {
          await deleteFromArchive(s.filePath, msg.paths, s.password);
          webview.postMessage({
            c: "del-ok",
            t: "Deleted " + msg.paths.length + " item(s). Reloading...",
          });
          await setupWebview(webview, s.archiveUri);
        } catch (err) {
          logger.error({ event: "webview.delSel.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        }
      }

      // ── Add Files ──
      if (msg.c === "addFiles") {
        const targetDir = typeof msg.dir === "string" ? msg.dir : "";
        logger.info({ event: "webview.addFiles", dir: targetDir });
        initAddToArchive(s.filePath, targetDir, s.password, webview, s.archiveUri);
        vscode.commands.executeCommand("yjdyamv.smart-archive.addToArchive");
      }

      // ── New Folder ──
      if (msg.c === "newFolderPrompt") {
        const targetDir = typeof msg.dir === "string" ? msg.dir : "";
        const folderName = await vscode.window.showInputBox({
          prompt: "Folder name",
          placeHolder: "new-folder",
          validateInput: (v) =>
            !v.trim()
              ? "Folder name cannot be empty"
              : /[<>:"/\\|?*]/.test(v)
                ? 'Invalid characters: < > : " / \\ | ? *'
                : null,
        });
        if (!folderName || !folderName.trim()) {
          logger.info({ event: "webview.newFolder.cancelled" });
          webview.postMessage({ c: "loading", t: false });
          return;
        }
        const name = folderName.trim();
        logger.info({ event: "webview.newFolder", dir: targetDir, name });
        try {
          await createFolderInArchive(s.filePath, targetDir, name, s.password);
          webview.postMessage({ c: "del-ok", t: "done" });
          if (s.archiveUri) await setupWebview(webview, s.archiveUri);
        } catch (err) {
          logger.error({ event: "webview.newFolder.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        }
      }

      // ── Preview ──
      if (msg.c === "preview" && typeof msg.path === "string") {
        logger.info({ event: "webview.preview", path: msg.path });
        try {
          await previewFileFromArchive(s.filePath, msg.path, s.password);
        } catch (err) {
          logger.error({ event: "webview.preview.failed", err }, (err as Error).message);
          showErrorWithCopy(t("decompress.failed") + (err as Error).message);
        }
      }

      // ── Test ──
      if (msg.c === "test") {
        logger.info({ event: "webview.test", path: s.filePath });
        try {
          const result = await testArchive(s.filePath, s.password);
          webview.postMessage({ c: "ok", t: result });
        } catch (err) {
          logger.error({ event: "webview.test.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        }
      }
    },
  );
}

export type { HandlerState };
export { setupWebview, handlerStates, handlerRegistered, registerHandler };
