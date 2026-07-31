/**
 * Handle selective extract from webview.
 *
 * @module providers/webview/handlers/extractSelected
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { extractSelected } from "../../extraction";
import { startOperation, endOperation } from "../state";

export const handleExtractSelected: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
  logger.info({ event: "webview.extSel", count: msg.paths.length, first: msg.paths[0] });
  if ([".deb", ".rpm"].includes(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  const token = startOperation(s);
  try {
    await extractSelected(s.filePath, msg.paths, s.password, msg.flat, undefined, msg.excludes);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    logger.info({ event: "webview.extSel.complete", count: msg.paths.length });
    webview.postMessage({ c: "ok", t: t("decompress.done") + s.archiveName });
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.extSel.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    endOperation(s);
  }
};
