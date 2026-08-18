/**
 * Handle delete-entries from webview.
 *
 * @module providers/webview/handlers/deleteEntries
 */

import * as vscode from "vscode";
import * as fs from "fs";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt, isWrappedFormat } from "../../../constants";
import { deleteFromArchive } from "../../archive";
import { setupWebview } from "../setup";
import { isReadOnlyExt, getWebviewUris } from "../helpers";
import { emptyHtml } from "../../htmlRenderer";
import { startOperation, endOperation } from "../state";

export const handleDelete: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  logger.info({ event: "webview.delSel", count: msg.paths.length, first: msg.paths[0] });

  const confirm = await vscode.window.showWarningMessage(
    t("archive.deletingProgress", String(msg.paths.length)),
    { modal: true },
    t("delete.confirm"),
  );
  if (confirm !== t("delete.confirm")) {
    webview.postMessage({ c: "loading", t: false });
    return;
  }

  const token = startOperation(s);
  try {
    // Deleting rebuilds the whole archive (7-Zip has no in-place delete)
    // and recompresses the remaining data — on large high-compression
    // archives this takes tens of seconds with NO progress output from
    // `7z d`. Tell the user up front instead of showing a static spinner.
    webview.postMessage({ c: "loading", t: t("archive.deletingRebuild") });

    const ext = getFullExt(s.filePath);
    let pathsToDelete = msg.paths;
    if (isWrappedFormat(ext)) {
      const expanded = new Set(pathsToDelete);
      for (const p of msg.paths) {
        const prefix = p + "/";
        for (const entry of s.entries) {
          if (entry.path.startsWith(prefix)) {
            expanded.add(entry.path);
          }
        }
      }
      pathsToDelete = [...expanded];
      logger.debug({
        event: "webview.delSel.expanded",
        original: msg.paths.length,
        expanded: pathsToDelete.length,
      });
    }

    await deleteFromArchive(s.filePath, pathsToDelete, s.password);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.delSel.ok", count: msg.paths.length });

    // RAR never keeps an empty archive: deleting every member erases the
    // archive file itself (official `rar d` behavior). Refreshing would
    // fail on the missing file — render a clear end state instead.
    if (!fs.existsSync(s.filePath)) {
      logger.info({ event: "webview.delSel.erasedArchive", filePath: s.filePath });
      const { cssUri, jsUri, codiconCssUri } = getWebviewUris(webview);
      webview.html = emptyHtml(t("archive.deletedAllErased"), cssUri, jsUri, codiconCssUri);
      return;
    }

    try {
      await setupWebview(
        webview,
        s.archiveUri,
        t("archive.toastDeleted", String(msg.paths.length)),
      );
    } catch (err) {
      logger.warn(
        { event: "webview.delSel.refreshFailed", err },
        "Failed to refresh webview after delete",
      );
    }
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.delSel.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
