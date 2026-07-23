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
import { getFullExt, isSplitVolume, isEncryptableExt } from "../../../constants";
import { fetchFileList } from "../../fileListing";
import {
  buildTreeRootOnly,
  buildEntryIndex,
  markNoisyDirs,
  countAllStats,
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
      },
      getNoisyPatterns(),
      pwToast,
    );
    const scripts: string[] = [];
    if (isSplitVolume(s.filePath)) {
      scripts.push("window._xIsSplit=true");
    }
    if ([".7z", ".zip"].includes(ext) && !isSplitVolume(s.filePath)) {
      scripts.push("window._xCanSplit=true");
    }
    scripts.push("window._xIsEncrypted=true");
    if (isEncryptableExt(ext)) scripts.push("window._xCanEncrypt=true");
    const persisted = await loadExpandedPaths(s.archiveUri, true);
    if (persisted.length > 0) {
      scripts.push(`window._xExpanded=${JSON.stringify(persisted)}`);
    }
    if (scripts.length > 0) {
      webview.html = webview.html.replace(
        "</body>",
        `<script>${scripts.join(";")}</script></body>`,
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
