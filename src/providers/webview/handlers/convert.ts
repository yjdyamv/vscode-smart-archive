/**
 * Handle format-convert from webview.
 *
 * @module providers/webview/handlers/convert
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { ArchiveService } from "../../../services/archiveService";
import { startOperation, endOperation } from "../state";
import { promptConvertFormat } from "./shared";

export const handleConvert: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.convert", path: s.filePath });
  const token = startOperation(s);
  try {
    const fmt = await promptConvertFormat();
    if (!fmt) {
      endOperation(s);
      return;
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const oldExt = getFullExt(s.filePath);
    const dst = s.filePath.slice(0, -oldExt.length) + `.${fmt}`;
    webview.postMessage({ c: "loading", t: t("archive.converting") });
    await ArchiveService.convert(
      s.filePath,
      fmt,
      dst,
      s.password ?? "",
      undefined,
      undefined,
      token,
    );
    logger.info({ event: "webview.convert.complete", dst });
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.convert.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
