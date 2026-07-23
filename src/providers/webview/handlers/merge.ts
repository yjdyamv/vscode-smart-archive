/**
 * Handle merge-split-volumes from webview.
 *
 * @module providers/webview/handlers/merge
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { ArchiveService } from "../../../services/archiveService";
import { startOperation, endOperation } from "../state";
import { getSplitVolumeStem, resolveWritableFormat } from "./shared";

export const handleMerge: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.merge", path: s.filePath });
  const token = startOperation(s);
  try {
    const ext = getFullExt(s.filePath);
    let fmt = ext.slice(1);
    fmt = (await resolveWritableFormat(fmt)) ?? "";
    if (!fmt) {
      endOperation(s);
      return;
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const base = getSplitVolumeStem(s.filePath);
    const dst = base + "." + fmt;
    webview.postMessage({ c: "loading", t: t("archive.merging") });
    await ArchiveService.convert(
      s.filePath,
      fmt,
      dst,
      s.password ?? "",
      undefined,
      undefined,
      token,
    );
    logger.info({ event: "webview.merge.complete", dst });
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
  } catch (err) {
    if (err instanceof vscode.CancellationError) return;
    logger.error({ event: "webview.merge.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
