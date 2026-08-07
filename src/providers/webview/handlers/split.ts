/**
 * Handle split-archive from webview.
 *
 * @module providers/webview/handlers/split
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { convertArchive } from "../../../services/archiveService";
import { promptVolumeSize } from "../../../ui/prompts";
import { startOperation, endOperation } from "../state";

export const handleSplit: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.split", path: s.filePath });
  const token = startOperation(s);
  try {
    const volSize = await promptVolumeSize();
    if (!volSize) {
      endOperation(s);
      return;
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const ext = getFullExt(s.filePath);
    const fmt = ext.slice(1);
    const dir = path.dirname(s.filePath);
    const base = path.basename(s.filePath);
    const folderName = base.replace(/\.[^.]+$/, "");
    let folderPath = path.join(dir, folderName);
    if (fs.existsSync(folderPath)) {
      let i = 1;
      while (fs.existsSync(path.join(dir, `${folderName}_${i}`))) i++;
      folderPath = path.join(dir, `${folderName}_${i}`);
    }
    const dst = path.join(folderPath, base);
    webview.postMessage({ c: "loading", t: t("archive.splitting") });
    await convertArchive(s.filePath, fmt, dst, s.password ?? "", volSize, undefined, token);
    logger.info({ event: "webview.split.ok", dst });
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${folderPath}` });
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.split.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
