/**
 * Handle copy-to-clipboard from webview.
 *
 * @module providers/webview/handlers/copy
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { setCopiedPaths } from "../../copyPaste";

export const handleCopy: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
  setCopiedPaths(msg.paths, s.filePath, s.password, msg.flat);
  logger.info({ event: "webview.copy", count: msg.paths.length, flat: msg.flat });
  vscode.window.showInformationMessage(t("archive.copied", String(msg.paths.length)));
  vscode.commands.executeCommand("yjdyamv.smart-archive.paste");
};
