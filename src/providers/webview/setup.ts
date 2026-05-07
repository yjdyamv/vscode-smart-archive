/**
 * Webview setup — Smart Archive VSCode Extension
 *
 * Initializes an archive webview: resolves RAR volumes, detects encryption,
 * fetches file listing, builds the tree, and renders the content HTML.
 *
 * @module providers/webview/setup
 */

import * as vscode from "vscode";
import * as path from "path";
import { isEncrypted } from "../../engines/js7z-engine";
import { getFullExt, isWrappedFormat, isEncryptableExt, isSplitVolume } from "../../constants";
import { isRarVolume, resolveRarVolume } from "../../utils/rar";
import { logger } from "../../utils/logger";
import { t, formatCompactSize } from "../../i18n";
import { buildTreeRootOnly, buildEntryIndex, markNoisyDirs, countAllStats } from "../treeBuilder";
import { loadingHtml, emptyHtml, contentHtml } from "../htmlRenderer";
import { fetchFileList } from "../fileListing";
import { handlerStates, handlerRegistered } from "./state";
import { getNoisyPatterns, isReadOnlyExt, getWebviewUris } from "./helpers";
import { registerHandler } from "./router";
import { loadExpandedPaths as loadPersistedExpanded } from "./expandedState";

export async function setupWebview(
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
        t("decompress.rarVolume", path.basename(filePath)),
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
  let isEnc = false;
  if (isEncryptableExt(getFullExt(filePath))) {
    let encrypted = false;
    try {
      encrypted = await isEncrypted(filePath);
    } catch {
      logger.warn(
        { event: "setupWebview.isEncrypted.failed" },
        "isEncrypted failed, may be multi-volume archive",
      );
    }
    if (encrypted) isEnc = true;

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
      if (isSplitVolume(filePath)) {
        webview.html = webview.html.replace(
          "</body>",
          `<script>window._xIsSplit=true</script></body>`,
        );
      }
      if ([".7z", ".zip"].includes(ext) && !isSplitVolume(filePath)) {
        webview.html = webview.html.replace(
          "</body>",
          `<script>window._xCanSplit=true</script></body>`,
        );
      }
      webview.html = webview.html.replace(
        "</body>",
        `<script>window._xIsEncrypted=true</script></body>`,
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
  const roToast =
    [".deb", ".rpm"].includes(roExt) || isSplitVolume(filePath) ? t("archive.readOnly") : toast;
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
  const readOnly = isReadOnlyExt(getFullExt(filePath)) || isSplitVolume(filePath);
  if (readOnly) {
    webview.html = webview.html.replace(
      "</body>",
      `<script>window._xReadOnly=true</script></body>`,
    );
  }

  // Pass split-volume flag so the frontend can show a Merge button
  if (isSplitVolume(filePath)) {
    webview.html = webview.html.replace("</body>", `<script>window._xIsSplit=true</script></body>`);
  }

  // For non-split 7z/zip, flag that splitting is available
  if ([".7z", ".zip"].includes(ext) && !isSplitVolume(filePath)) {
    webview.html = webview.html.replace(
      "</body>",
      `<script>window._xCanSplit=true</script></body>`,
    );
  }

  if (isEnc) {
    webview.html = webview.html.replace(
      "</body>",
      `<script>window._xIsEncrypted=true</script></body>`,
    );
  }

  // Restore previously expanded directories
  const persisted = loadPersistedExpanded(archiveUri);
  if (persisted.length > 0) {
    webview.html = webview.html.replace(
      "</body>",
      `<script>window._xExpanded=${JSON.stringify(persisted)}</script></body>`,
    );
  }

  if (!handlerRegistered.has(webview)) {
    handlerRegistered.add(webview);
    registerHandler(webview);
  }

  logger.info({ event: "setupWebview.done", filePath, entryCount: entries.length });
}
