/**
 * Handle integrity-test from webview.
 *
 * @module providers/webview/handlers/test
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { testArchive } from "../../archive";
import { startOperation, endOperation } from "../state";

export const handleTest: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.test", path: s.filePath });
  const token = startOperation(s);
  try {
    const result = await testArchive(s.filePath, s.password);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.test.complete" });
    webview.postMessage({ c: "ok", t: result });
  } catch (err) {
    if (err instanceof vscode.CancellationError) return;
    logger.error({ event: "webview.test.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    endOperation(s);
  }
};
