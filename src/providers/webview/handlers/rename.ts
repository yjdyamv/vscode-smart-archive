/**
 * Handle rename-entry from webview.
 *
 * @module providers/webview/handlers/rename
 */

import * as vscode from "vscode";
import * as path from "path";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { renameInArchive } from "../../archive";
import { isValidEntryName } from "../../../utils/security";
import { setupWebview } from "../setup";
import { isReadOnlyExt, showErrorWithCopy } from "../helpers";
import { startOperation, endOperation } from "../state";

export const handleRename: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (typeof msg.path !== "string") return;
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  const oldPath = msg.path;
  const oldName = path.basename(oldPath);
  const newName = await vscode.window.showInputBox({
    prompt: t("archive.renamePrompt"),
    value: oldName,
    validateInput: (v) =>
      !v.trim()
        ? t("validation.nameEmpty")
        : !isValidEntryName(v.trim())
          ? t("validation.nameInvalidChars")
          : v.trim() === oldName
            ? t("validation.nameSameName")
            : null,
  });
  if (!newName || !newName.trim() || newName.trim() === oldName) {
    logger.info({ event: "webview.rename.cancelled", oldPath });
    return;
  }
  // Defense in depth: showInputBox validation is UI-only; a crafted message
  // flow must not rename to "." / ".." / separators.
  if (!isValidEntryName(newName.trim())) {
    logger.warn({ event: "webview.rename.invalidName", oldPath, newName });
    return;
  }
  const parentDir = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/") + 1) : "";
  const newPath = parentDir + newName.trim();
  logger.info({ event: "webview.rename", oldPath, newPath });
  const token = startOperation(s);
  try {
    webview.postMessage({ c: "loading", t: t("archive.renaming") });
    await renameInArchive(s.filePath, oldPath, newPath, s.password);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.rename.ok", oldPath, newPath });
    if (s.archiveUri) {
      try {
        await setupWebview(webview, s.archiveUri, t("archive.toastRenamed"));
      } catch (err) {
        logger.warn(
          { event: "webview.rename.refreshFailed", err },
          "Failed to refresh webview after rename",
        );
      }
    }
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.rename.failed", err }, (err as Error).message);
    showErrorWithCopy(t("decompress.failed") + (err as Error).message);
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
