/**
 * Handle password submission from webview.
 *
 * @module providers/webview/handlers/password
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { logger } from "../../../utils/logger";
import { t, formatCompactSize } from "../../../i18n";
import { isPasswordOrEncryptError } from "../../../utils/errorClassifier";
import {
  getFullExt,
  isSplitVolume,
  isEncryptableExt,
  getCompressedArchiveSize,
} from "../../../constants";
import { fetchFileList } from "../../fileListing";
import {
  buildTreeRootOnly,
  buildEntryIndex,
  markNoisyDirs,
  countAllStats,
  buildDescendantCounts,
} from "../../treeBuilder";
import { contentHtml } from "../../htmlRenderer";
import { loadExpandedPaths } from "../expandedState";
import { getWebviewUris, getNoisyPatterns } from "../helpers";
import { verifyArchivePassword } from "./shared";
import { startOperation, endOperation } from "../state";

export const handlePassword: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (!msg.pw) return;
  logger.info({ event: "webview.password.attempt" });
  const token = startOperation(s);
  try {
    const pwEntries = await fetchFileList(s.filePath, msg.pw);
    if (pwEntries.length === 0) {
      webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
      return;
    }

    if (token.isCancellationRequested) throw new vscode.CancellationError();

    logger.info({ event: "webview.password.ok", count: pwEntries.length });
    s.password = msg.pw;

    const resolvedExt = getFullExt(s.filePath);
    if (resolvedExt !== ".7z") {
      const valid = await verifyArchivePassword(s.filePath, msg.pw);
      if (!valid) {
        webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
        return;
      }
    }

    if (token.isCancellationRequested) throw new vscode.CancellationError();

    s.entries = pwEntries;
    s.entryIndex = buildEntryIndex(pwEntries);
    const pwTree = buildTreeRootOnly(pwEntries, s.archiveName);
    const descCounts = buildDescendantCounts(pwEntries);
    markNoisyDirs(pwTree, getNoisyPatterns());
    const pwStats = countAllStats(pwEntries);
    const ext = getFullExt(s.filePath);
    const pwToast =
      [".deb", ".rpm"].includes(ext) || isSplitVolume(s.filePath)
        ? t("archive.readOnly")
        : undefined;
    const { cssUri, jsUri, codiconCssUri } = getWebviewUris(webview);
    webview.html = contentHtml(
      pwTree,
      pwStats.files,
      pwStats.dirs,
      cssUri,
      jsUri,
      codiconCssUri,
      {
        name: s.archiveName,
        format: ext,
        count: pwStats.total,
        size: formatCompactSize(pwStats.totalSize),
        ratio: pwStats.totalSize > 0 ? getCompressedArchiveSize(s.filePath) / pwStats.totalSize : 0,
      },
      getNoisyPatterns(),
      pwToast,
    );
    const extra: string[] = [];
    if (isSplitVolume(s.filePath)) {
      extra.push(`<script type="application/json" id="_xIsSplit">true</script>`);
    }
    if ([".7z", ".zip"].includes(ext) && !isSplitVolume(s.filePath)) {
      extra.push(`<script type="application/json" id="_xCanSplit">true</script>`);
    }
    extra.push(`<script type="application/json" id="_xIsEncrypted">true</script>`);
    if (isEncryptableExt(ext)) extra.push(`<script type="application/json" id="_xCanEncrypt">true</script>`);
    const descObj = Object.create(null) as Record<string, { files: number; dirs: number }>;
    for (const [k, v] of descCounts) descObj[k] = v;
    extra.push(`<script type="application/json" id="_xDescCounts">${JSON.stringify(descObj)}</script>`);
    const persisted = await loadExpandedPaths(s.archiveUri, true);
    if (persisted.length > 0) {
      extra.push(`<script type="application/json" id="_xExpanded">${JSON.stringify(persisted)}</script>`);
    }
    if (extra.length > 0) {
      webview.html = webview.html.replace(
        "</body>",
        extra.join("") + "</body>",
      );
    }
  } catch (err) {
    if (err instanceof vscode.CancellationError) return;
    logger.error({ event: "webview.password.error", err });
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isPasswordOrEncryptError(errMsg)) {
      webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
    } else {
      webview.postMessage({ c: "err", t: errMsg });
    }
  } finally {
    endOperation(s);
  }
};
