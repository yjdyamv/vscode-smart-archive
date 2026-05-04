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
import { getFullExt, isWrappedFormat, isEncryptableExt, NOISY_DIR_PATTERNS } from "../constants";

function getNoisyPatterns(): string[] {
  return (
    vscode.workspace.getConfiguration("smart-archive").get<string[]>("collapsedDirPatterns") ??
    NOISY_DIR_PATTERNS
  );
}

function isReadOnlyExt(ext: string): boolean {
  return [
    ".rar",
    ".iso",
    ".vhd",
    ".vmdk",
    ".dmg",
    ".hfs",
    ".fat",
    ".ntfs",
    ".deb",
    ".rpm",
  ].includes(ext);
}

import { isRarVolume, resolveRarVolume } from "../utils/rar";
import { logger } from "../utils/logger";
import { t, formatCompactSize } from "../i18n";
import {
  buildTreeRootOnly,
  getDirChildren,
  buildEntryIndex,
  markNoisyDirs,
  countAllStats,
} from "./treeBuilder";
import type { FlatEntry, EntryIndex } from "./treeBuilder";
import { loadingHtml, emptyHtml, contentHtml } from "./htmlRenderer";
import { JS7z, tryCleanupJS7z, fetchFileList } from "./fileListing";
import { streamToVFS } from "../engines/js7z-helpers";
import { extractSelected } from "./extraction";
import {
  createFolderInArchive,
  deleteFromArchive,
  initAddToArchive,
  previewFileFromArchive,
  renameInArchive,
  testArchive,
} from "./archive";
import { setCopiedPaths } from "./copyPaste";
import { decompressWithKnownPassword } from "../commands/decompress";

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
  entries: FlatEntry[];
  entryIndex: EntryIndex;
}

const handlerStates = new WeakMap<vscode.Webview, HandlerState>();
const handlerRegistered = new WeakSet<vscode.Webview>();

function getWebviewUris(webview: vscode.Webview): {
  cssUri: string;
  jsUri: string;
  codiconCssUri: string;
} {
  const extUri = vscode.extensions.getExtension(EXT_ID)!.extensionUri;
  return {
    cssUri: webview
      .asWebviewUri(vscode.Uri.joinPath(extUri, "media", "vue", "assets", "style.css"))
      .toString(),
    jsUri: webview
      .asWebviewUri(vscode.Uri.joinPath(extUri, "media", "vue", "assets", "index.js"))
      .toString(),
    codiconCssUri: webview
      .asWebviewUri(
        vscode.Uri.joinPath(extUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css"),
      )
      .toString(),
  };
}

async function setupWebview(
  webview: vscode.Webview,
  archiveUri: vscode.Uri,
  toast?: string,
): Promise<void> {
  let filePath = archiveUri.fsPath;
  const ext = getFullExt(filePath);
  const { cssUri, jsUri, codiconCssUri } = getWebviewUris(webview);

  if (isRarVolume(ext)) {
    const rarPath = resolveRarVolume(filePath);
    if (rarPath) {
      filePath = rarPath;
    } else {
      webview.html = emptyHtml(
        `Multi-volume RAR: "${path.basename(filePath)}" requires a .rar file in the same directory.`,
        cssUri,
        jsUri,
        codiconCssUri,
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

  webview.html = loadingHtml(codiconCssUri);
  const prev = handlerStates.get(webview);
  let password = prev?.password;

  // For encryptable formats, detect encryption before listing files
  // to avoid leaking file structure from unencrypted ZIP headers.
  if (isEncryptableExt(getFullExt(filePath))) {
    let encrypted = false;
    try {
      encrypted = await isEncrypted(filePath);
    } catch {
      // isEncrypted can fail for multi-volume archives that need
      // all parts to list — don't blindly assume encryption.
    }

    if (encrypted && password) {
      logger.info({ event: "setupWebview.password.retry" });
      try {
        const pwEntries = await fetchFileList(filePath, password);
        if (pwEntries.length > 0) {
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
        password,
        entries: [],
        entryIndex: new Map(),
      });
      webview.html = contentHtml(
        [],
        0,
        0,
        cssUri,
        jsUri,
        codiconCssUri,
        { name: archiveName, format: ext, count: 0, size: "" },
        undefined,
        undefined,
        "password",
      );
      if (!handlerRegistered.has(webview)) {
        handlerRegistered.add(webview);
        registerHandler(webview);
      }
      return;
    }
  }

  let entries: { path: string; size: number; type: string }[];
  try {
    entries = await fetchFileList(filePath, password);
  } catch (err) {
    logger.error({ event: "setupWebview.fetchFileList.failed", err }, (err as Error).message);
    webview.html = emptyHtml(
      t("decompress.failed") + (err as Error).message,
      cssUri,
      jsUri,
      codiconCssUri,
    );
    return;
  }

  const entryIndex = buildEntryIndex(entries);

  handlerStates.set(webview, {
    archiveUri,
    archiveName,
    filePath,
    password,
    entries,
    entryIndex,
  });
  // Lazy root-only build for fast initial load.
  // Noisy dirs (node_modules etc.) stay collapsed — no loading triggered.
  // Non-noisy dirs are auto-expanded by the Vue app after mount.
  const tree = buildTreeRootOnly(entries, archiveName);
  const patterns = getNoisyPatterns();
  markNoisyDirs(tree, patterns);
  const stats = countAllStats(entries);
  const totalSize = stats.totalSize;
  const fileCount = stats.files;
  const dirCount = stats.dirs;
  const itemCount = stats.total;
  const roExt = getFullExt(filePath);
  const roToast = [".deb", ".rpm"].includes(roExt) ? t("archive.readOnly") : toast;
  webview.html = contentHtml(
    tree,
    fileCount,
    dirCount,
    cssUri,
    jsUri,
    codiconCssUri,
    {
      name: archiveName,
      format: ext,
      count: itemCount,
      size: formatCompactSize(totalSize),
    },
    patterns,
    roToast,
  );

  // Pass read-only flag
  const readOnly = isReadOnlyExt(getFullExt(filePath));
  if (readOnly) {
    webview.html = webview.html.replace(
      "</body>",
      `<script>window._xReadOnly=true</script></body>`,
    );
  }

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
      excludes?: string[];
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

      // ── Lazy tree: expand directory → fetch children on demand ──
      if (msg.c === "expandDir" && typeof msg.path === "string") {
        const children = getDirChildren(msg.path, s.entries, s.entryIndex);
        markNoisyDirs(children, getNoisyPatterns());
        webview.postMessage({ c: "dirChildren", path: msg.path, children });
        return;
      }

      const { cssUri, jsUri, codiconCssUri } = getWebviewUris(webview);

      // ── Password submit (encrypted archives) ──
      if (msg.c === "pw" && msg.pw) {
        logger.info({ event: "webview.password.attempt" });
        try {
          const pwEntries = await fetchFileList(s.filePath, msg.pw);
          if (pwEntries.length === 0) {
            webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
            return;
          }
          const js7z = await JS7z({ print: () => {}, printErr: () => {} });
          try {
            const testPath = streamToVFS(js7z, s.filePath);
            await new Promise<void>((resolve, reject) => {
              js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z t: ${c}`)));
              js7z.callMain(["t", `-p${msg.pw}`, testPath]);
            });
          } catch {
            logger.warn({ event: "webview.password.testFailed" }, "Password verification failed");
            webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
            return;
          } finally {
            tryCleanupJS7z(js7z);
          }
          logger.info({ event: "webview.password.ok", count: pwEntries.length });
          s.password = msg.pw;
          s.entries = pwEntries;
          s.entryIndex = buildEntryIndex(pwEntries);
          const pwTree = buildTreeRootOnly(pwEntries, s.archiveName);
          markNoisyDirs(pwTree, getNoisyPatterns());
          const pwStats = countAllStats(pwEntries);
          const pwTotalSize = pwStats.totalSize;
          const fc = pwStats.files;
          const dc = pwStats.dirs;
          const itemCount = pwStats.total;
          const ext = getFullExt(s.filePath);
          const pwToast = [".deb", ".rpm"].includes(ext) ? t("archive.readOnly") : undefined;
          webview.html = contentHtml(
            pwTree,
            fc,
            dc,
            cssUri,
            jsUri,
            codiconCssUri,
            {
              name: s.archiveName,
              format: ext,
              count: itemCount,
              size: formatCompactSize(pwTotalSize),
            },
            getNoisyPatterns(),
            pwToast,
          );
        } catch (err) {
          logger.error({ event: "webview.password.error", err });
          webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
        }
        return;
      }

      // ── Extract All ──
      if (msg.c === "extAll") {
        logger.info({ event: "webview.extAll", archiveName: s.archiveName });
        try {
          if (s.password) {
            await decompressWithKnownPassword(s.archiveUri, s.password);
          } else {
            await vscode.commands.executeCommand("yjdyamv.smart-archive.decompress", s.archiveUri);
          }
          webview.postMessage({ c: "ok", t: t("decompress.done") + s.archiveName });
        } catch (err) {
          logger.error({ event: "webview.extAll.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        }
      }

      // ── Extract Selected ──
      if (msg.c === "extSel" && Array.isArray(msg.paths) && msg.paths.length > 0) {
        logger.info({ event: "webview.extSel", count: msg.paths.length, first: msg.paths[0] });
        const selExt = getFullExt(s.filePath);
        if ([".deb", ".rpm"].includes(selExt)) {
          webview.postMessage({ c: "err", t: t("archive.readOnly") });
          return;
        }
        try {
          await extractSelected(
            s.filePath,
            msg.paths,
            s.password,
            msg.flat,
            undefined,
            msg.excludes,
          );
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
        if (isReadOnlyExt(getFullExt(s.filePath))) {
          webview.postMessage({ c: "err", t: t("archive.readOnly") });
          return;
        }
        logger.info({ event: "webview.delSel", count: msg.paths.length, first: msg.paths[0] });
        try {
          webview.postMessage({ c: "loading", t: "Deleting..." });
          await deleteFromArchive(s.filePath, msg.paths, s.password);
          try {
            await setupWebview(
              webview,
              s.archiveUri,
              t("archive.toastDeleted", String(msg.paths.length)),
            );
          } catch {}
        } catch (err) {
          logger.error({ event: "webview.delSel.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        } finally {
          webview.postMessage({ c: "loading", t: false });
        }
      }

      // ── Rename ──
      if (msg.c === "renamePrompt" && typeof msg.path === "string") {
        if (isReadOnlyExt(getFullExt(s.filePath))) {
          webview.postMessage({ c: "err", t: t("archive.readOnly") });
          return;
        }
        const oldPath = msg.path;
        const oldName = path.basename(oldPath);
        const newName = await vscode.window.showInputBox({
          prompt: "Rename to",
          value: oldName,
          validateInput: (v) =>
            !v.trim()
              ? "Name cannot be empty"
              : /[<>:"/\\|?*]/.test(v)
                ? 'Invalid characters: < > : " / \\ | ? *'
                : v.trim() === oldName
                  ? "New name is the same as current"
                  : null,
        });
        if (!newName || !newName.trim() || newName.trim() === oldName) {
          logger.info({ event: "webview.rename.cancelled", oldPath });
          return;
        }
        const parentDir = oldPath.includes("/")
          ? oldPath.slice(0, oldPath.lastIndexOf("/") + 1)
          : "";
        const newPath = parentDir + newName.trim();
        logger.info({ event: "webview.rename", oldPath, newPath });
        try {
          webview.postMessage({ c: "loading", t: "Renaming..." });
          await renameInArchive(s.filePath, oldPath, newPath, s.password);
          if (s.archiveUri) {
            try {
              await setupWebview(webview, s.archiveUri, t("archive.toastRenamed"));
            } catch {}
          }
        } catch (err) {
          logger.error({ event: "webview.rename.failed", err }, (err as Error).message);
          showErrorWithCopy(t("decompress.failed") + (err as Error).message);
        } finally {
          webview.postMessage({ c: "loading", t: false });
        }
      }

      // ── Add Files ──
      if (msg.c === "addFiles") {
        if (isReadOnlyExt(getFullExt(s.filePath))) {
          webview.postMessage({ c: "err", t: t("archive.readOnly") });
          return;
        }
        const targetDir = typeof msg.dir === "string" ? msg.dir : "";
        logger.info({ event: "webview.addFiles", dir: targetDir });
        initAddToArchive(s.filePath, targetDir, s.password, webview, s.archiveUri, setupWebview);
        vscode.commands.executeCommand("yjdyamv.smart-archive.addToArchive");
      }

      // ── New Folder ──
      if (msg.c === "newFolderPrompt") {
        if (isReadOnlyExt(getFullExt(s.filePath))) {
          webview.postMessage({ c: "err", t: t("archive.readOnly") });
          return;
        }
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
          webview.postMessage({ c: "loading", t: "Creating folder..." });
          await createFolderInArchive(s.filePath, targetDir, name, s.password);
          if (s.archiveUri) {
            try {
              await setupWebview(webview, s.archiveUri, t("archive.toastCreatedFolder"));
            } catch {}
          }
        } catch (err) {
          logger.error({ event: "webview.newFolder.failed", err }, (err as Error).message);
          webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
        } finally {
          webview.postMessage({ c: "loading", t: false });
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
