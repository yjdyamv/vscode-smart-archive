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
    const ext = getFullExt(s.filePath);
    const fmt = ext.slice(1);
    // RAR5 split sets can carry .rev recovery volumes (WinRAR -rv):
    // offer a count, defaulting to none (0).
    let recoveryVolumeCount: number | undefined;
    if (fmt === "rar") {
      const picked = await vscode.window.showQuickPick(
        [
          { label: "0", description: t("split.recoveryNone"), value: 0 },
          { label: "1", description: t("split.recoveryOne"), value: 1 },
          { label: "2", description: t("split.recoveryFew"), value: 2 },
          { label: "3", description: t("split.recoveryFew"), value: 3 },
          { label: "5", description: t("split.recoveryFew"), value: 5 },
          { label: "10", description: t("split.recoveryMany"), value: 10 },
        ],
        { placeHolder: t("split.recoveryPrompt"), ignoreFocusOut: true },
      );
      if (!picked) {
        endOperation(s);
        return;
      }
      if (picked.value > 0) recoveryVolumeCount = picked.value;
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
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
    await convertArchive(
      s.filePath,
      fmt,
      dst,
      s.password ?? "",
      volSize,
      undefined,
      token,
      recoveryVolumeCount,
    );
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
