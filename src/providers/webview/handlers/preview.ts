/**
 * Handle file preview from webview.
 *
 * @module providers/webview/handlers/preview
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { previewFileFromArchive } from "../../archive";
import { showErrorWithCopy } from "../helpers";
import { startOperation, endOperation } from "../state";

export const handlePreview: MessageHandler = async (ctx) => {
  const { state: s, msg } = ctx;
  if (typeof msg.path !== "string") return;
  logger.info({ event: "webview.preview", path: msg.path });
  const token = startOperation(s);
  try {
    await previewFileFromArchive(s.filePath, msg.path, s.password);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.preview.ok", path: msg.path });
  } catch (err) {
    if (isCancellationError(err)) return;
    const errMsg = err instanceof Error ? err.message : String(err ?? "");
    logger.error({ event: "webview.preview.failed", err }, errMsg);
    showErrorWithCopy(t("decompress.failed") + " " + errMsg);
  } finally {
    endOperation(s);
  }
};
