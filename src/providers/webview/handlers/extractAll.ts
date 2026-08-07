/**
 * Handle extract-all from webview.
 *
 * @module providers/webview/handlers/extractAll
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { decompressWithKnownPassword } from "../../../commands/decompress";
import { startOperation, endOperation } from "../state";

export const handleExtractAll: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.extAll", archiveName: s.archiveName });
  const token = startOperation(s);
  try {
    if (s.password) {
      await decompressWithKnownPassword(s.archiveUri, s.password);
    } else {
      await vscode.commands.executeCommand("yjdyamv.smart-archive.decompress", s.archiveUri);
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.extAll.ok", archiveName: s.archiveName });
    webview.postMessage({ c: "ok", t: t("decompress.done") + s.archiveName });
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.extAll.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    endOperation(s);
  }
};
