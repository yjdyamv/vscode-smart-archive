/**
 * Handle integrity-test from webview.
 *
 * @module providers/webview/handlers/test
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { testArchive } from "../../archive";
import { startOperation, endOperation } from "../state";

export const handleTest: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.test", path: s.filePath });
  const token = startOperation(s);
  try {
    // Immediate in-webview feedback — the test itself may take a while.
    webview.postMessage({ c: "loading", t: t("archive.testing") });
    const result = await testArchive(s.filePath, s.password);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.test.ok" });
    webview.postMessage({ c: "ok", t: result });
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.test.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    endOperation(s);
  }
};
