/**
 * Handle add-files from webview.
 *
 * @module providers/webview/handlers/addFiles
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt } from "../../../constants";
import { initAddToArchive } from "../../archive";
import { sanitizeTargetDir } from "../../../utils/security";
import { setupWebview } from "../setup";
import { isReadOnlyExt } from "../helpers";

export const handleAddFiles: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  let targetAddDir: string;
  try {
    targetAddDir = sanitizeTargetDir(typeof msg.dir === "string" ? msg.dir : "");
  } catch (err) {
    webview.postMessage({ c: "err", t: (err as Error).message });
    return;
  }
  logger.info({ event: "webview.addFiles", dir: targetAddDir });
  initAddToArchive(s.filePath, targetAddDir, s.password, webview, s.archiveUri, setupWebview);
  vscode.commands.executeCommand("yjdyamv.smart-archiver.addToArchive");
};
