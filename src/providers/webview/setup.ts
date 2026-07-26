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
import {
  getFullExt,
  isWrappedFormat,
  isEncryptableExt,
  isSplitVolume,
  resolveSplitVolume,
  getCompressedArchiveSize,
} from "../../constants";
import { isRarVolume, resolveRarVolume } from "../../utils/rar";
import { logger } from "../../utils/logger";
import { t, formatCompactSize } from "../../i18n";
import {
  buildTreeRootOnly,
  buildEntryIndex,
  markNoisyDirs,
  countAllStats,
  buildDescendantCounts,
} from "../treeBuilder";
import { loadingHtml, emptyHtml, contentHtml, escapeJsonForScript } from "../htmlRenderer";
import { fetchFileList } from "../fileListing";
import { handlerStates, handlerRegistered } from "./state";
import { getNoisyPatterns, isReadOnlyExt, getWebviewUris } from "./helpers";
import { registerHandler } from "./router";
import { loadExpandedPaths } from "./expandedState";

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

  // Redirect 7z/zip/wim .002+ → .001 so system 7z can find archive headers
  const nonFirstVol = filePath.match(/\.(7z|zip|wim)\.(\d+)$/i);
  if (nonFirstVol && nonFirstVol[2] !== "001") {
    const resolved = resolveSplitVolume(filePath);
    if (resolved) {
      filePath = resolved;
    } else {
      webview.html = emptyHtml(
        t("decompress.noSplitParts", path.basename(filePath)),
        cssUri,
        jsUri,
        codiconCssUri,
      );
      return;
    }
  }

  const archiveName = path.basename(filePath);
  // Recalculate ext after potential volume redirection above
  const resolvedExt = getFullExt(filePath);
  logger.info({
    event: "setupWebview.start",
    filePath,
    ext: resolvedExt,
    wrapped: isWrappedFormat(resolvedExt),
  });

  webview.html = loadingHtml(codiconCssUri);
  const prev = handlerStates.get(webview);
  let password = prev?.password;

  // For encryptable formats, detect encryption before listing files
  // to avoid leaking file structure from unencrypted ZIP headers.
  let isEnc = false;
  let encryptionDetectionFailed = false;
  if (isEncryptableExt(getFullExt(filePath))) {
    let encrypted = false;
    try {
      encrypted = await isEncrypted(filePath);
    } catch {
      encryptionDetectionFailed = true;
      logger.warn(
        { event: "setupWebview.isEncrypted.failed" },
        "isEncrypted failed, may be multi-volume archive",
      );
      // For encryptable formats where detection failed (e.g. split volumes),
      // try with the cached password first; if no password, treat as encrypted
      // to show the password prompt (safer than leaking unencrypted content).
    }
    if (encrypted) isEnc = true;

    if ((encrypted || encryptionDetectionFailed) && password) {
      logger.info({ event: "setupWebview.password.retry" });
      try {
        const pwEntries = await fetchFileList(filePath, password);
        if (pwEntries.length > 0) {
          encrypted = false;
          isEnc = false;
          encryptionDetectionFailed = false;
          logger.info({ event: "setupWebview.password.retrySuccess", count: pwEntries.length });
        }
      } catch {
        logger.warn({ event: "setupWebview.password.retryFailed" });
      }
    }

    if (encrypted || (encryptionDetectionFailed && !password)) {
      logger.info({ event: "setupWebview.passwordRequired" });
      handlerStates.set(webview, {
        archiveUri,
        archiveName,
        filePath,
        password,
        entries: [],
        entryIndex: new Map(),
        isEncrypted: true,
        cancelSource: null,
      });
      webview.html = contentHtml(
        [],
        0,
        0,
        cssUri,
        jsUri,
        codiconCssUri,
        { name: archiveName, format: resolvedExt, count: 0, size: "", ratio: 0 },
        undefined,
        undefined,
        "password",
      );
      const flags: string[] = [];
      if (isSplitVolume(filePath)) {
        flags.push("window._xIsSplit=true");
      } else if ([".7z", ".zip"].includes(resolvedExt)) {
        flags.push("window._xCanSplit=true");
      }
      flags.push("window._xIsEncrypted=true");
      if (isEncryptableExt(resolvedExt)) flags.push("window._xCanEncrypt=true");
      webview.html = webview.html.replace("</body>", `<script>${flags.join(";")}</script></body>`);
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
    isEncrypted: isEnc,
    cancelSource: null,
  });
  // Lazy root-only build for fast initial load.
  // Noisy dirs (node_modules etc.) stay collapsed — no loading triggered.
  // Non-noisy dirs are auto-expanded by the Vue app after mount.
  const tree = buildTreeRootOnly(entries, archiveName);
  const descCounts = buildDescendantCounts(entries);
  const patterns = getNoisyPatterns();
  markNoisyDirs(tree, patterns);
  const stats = countAllStats(entries);
  const totalSize = stats.totalSize;
  const fileCount = stats.files;
  const dirCount = stats.dirs;
  const itemCount = stats.total;
  const archiveFileSize = getCompressedArchiveSize(filePath);
  const ratio = totalSize > 0 ? archiveFileSize / totalSize : 0;
  const roExt = resolvedExt;
  const roToast =
    [".deb", ".rpm"].includes(roExt) || isSplitVolume(filePath) ? t("archive.readOnly") : undefined;
  const finalToast = toast ?? roToast;
  webview.html = contentHtml(
    tree,
    fileCount,
    dirCount,
    cssUri,
    jsUri,
    codiconCssUri,
    {
      name: archiveName,
      format: resolvedExt,
      count: itemCount,
      size: formatCompactSize(totalSize),
      ratio,
    },
    patterns,
    finalToast,
  );

  // Precomputed descendant counts for accurate toolbar selection count
  const descObj = Object.create(null) as Record<string, { files: number; dirs: number }>;
  for (const [k, v] of descCounts) descObj[k] = v;

  const extra: string[] = [];
  if (isSplitVolume(filePath))
    extra.push(
      `<script type="application/json" id="_xReadOnly">true</script><script type="application/json" id="_xIsSplit">true</script>`,
    );
  else {
    if (isReadOnlyExt(resolvedExt))
      extra.push(`<script type="application/json" id="_xReadOnly">true</script>`);
    if ([".7z", ".zip"].includes(resolvedExt))
      extra.push(`<script type="application/json" id="_xCanSplit">true</script>`);
  }
  if (isEnc) extra.push(`<script type="application/json" id="_xIsEncrypted">true</script>`);
  if (isEncryptableExt(resolvedExt))
    extra.push(`<script type="application/json" id="_xCanEncrypt">true</script>`);
  extra.push(
    `<script type="application/json" id="_xDescCounts">${escapeJsonForScript(JSON.stringify(descObj))}</script>`,
  );
  const persisted = await loadExpandedPaths(archiveUri, isEnc);
  if (persisted.length > 0)
    extra.push(
      `<script type="application/json" id="_xExpanded">${escapeJsonForScript(JSON.stringify(persisted))}</script>`,
    );
  if (extra.length > 0) {
    webview.html = webview.html.replace("</body>", extra.join("") + "</body>");
  }

  if (!handlerRegistered.has(webview)) {
    handlerRegistered.add(webview);
    registerHandler(webview);
  }

  logger.info({ event: "setupWebview.done", filePath, entryCount: entries.length });
}
