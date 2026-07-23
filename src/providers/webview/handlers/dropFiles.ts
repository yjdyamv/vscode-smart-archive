/**
 * Handle drag-drop add from webview.
 *
 * @module providers/webview/handlers/dropFiles
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { addToArchive } from "../../archive";
import { sanitizeTargetDir } from "../../../utils/security";
import { setupWebview } from "../setup";
import { isReadOnlyExt } from "../helpers";
import { startOperation, endOperation } from "../state";

export const handleDropFiles: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
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
  logger.info({
    event: "webview.dropFiles",
    count: msg.paths.length,
    dir: targetDir,
    first: msg.paths[0],
  });
  const token = startOperation(s);
  try {
    webview.postMessage({ c: "loading", t: t("archive.addingFilesProgress") });
    await addToArchive(s.filePath, msg.paths, targetDir, s.password);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.dropFiles.complete", count: msg.paths.length });
    try {
      await setupWebview(webview, s.archiveUri, t("archive.toastAddedFiles"));
    } catch (err) {
      logger.warn(
        { event: "webview.dropFiles.refreshFailed", err },
        "Failed to refresh webview after dropFiles",
      );
    }
  } catch (err) {
    if (err instanceof vscode.CancellationError) return;
    logger.error({ event: "webview.dropFiles.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
