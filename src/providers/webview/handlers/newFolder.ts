/**
 * Handle new-folder creation from webview.
 *
 * @module providers/webview/handlers/newFolder
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { createFolderInArchive } from "../../archive";
import { sanitizeTargetDir } from "../../../utils/security";
import { setupWebview } from "../setup";
import { isReadOnlyExt } from "../helpers";
import { startOperation, endOperation } from "../state";

export const handleNewFolder: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  let targetDir: string;
  try {
    targetDir = sanitizeTargetDir(typeof msg.dir === "string" ? msg.dir : "");
  } catch (err) {
    webview.postMessage({ c: "err", t: (err as Error).message });
    return;
  }
  const folderName = await vscode.window.showInputBox({
    prompt: t("archive.folderNamePrompt"),
    placeHolder: t("archive.folderNamePlaceholder"),
    validateInput: (v) =>
      !v.trim()
        ? t("validation.nameEmpty")
        : v.includes("\0")
          ? t("validation.nameInvalidChar")
          : /[<>:"/\\|?*]/.test(v)
            ? t("validation.nameInvalidChars")
            : v.length > 255
              ? t("validation.nameTooLong")
              : null,
  });
  if (!folderName || !folderName.trim()) {
    logger.info({ event: "webview.newFolder.cancelled" });
    webview.postMessage({ c: "loading", t: false });
    return;
  }
  const name = folderName.trim();
  logger.info({ event: "webview.newFolder", dir: targetDir, name });
  const token = startOperation(s);
  try {
    webview.postMessage({ c: "loading", t: t("archive.creatingFolder") });
    await createFolderInArchive(s.filePath, targetDir, name, s.password);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.newFolder.ok", dir: targetDir, name });
    if (s.archiveUri) {
      try {
        await setupWebview(webview, s.archiveUri, t("archive.toastCreatedFolder"));
      } catch (err) {
        logger.warn(
          { event: "webview.newFolder.refreshFailed", err },
          "Failed to refresh webview after newFolder",
        );
      }
    }
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.newFolder.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
