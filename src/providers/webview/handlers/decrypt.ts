/**
 * Handle decrypt-archive from webview.
 *
 * @module providers/webview/handlers/decrypt
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt, isSplitVolume } from "../../../constants";
import { convertArchive } from "../../../services/archiveService";
import { startOperation, endOperation } from "../state";
import { uniquePath } from "../helpers";
import { pwInputBox, resolveWritableFormat, detectVolumeSize, getSplitOutputPath } from "./shared";

export const handleDecrypt: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.decrypt", path: s.filePath });
  const token = startOperation(s);
  try {
    let pw = s.password;
    if (!pw) {
      pw = await pwInputBox(t("archive.decryptPrompt"));
      if (!pw) {
        endOperation(s);
        return;
      }
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const ext = getFullExt(s.filePath);
    let fmt = ext.slice(1);
    fmt = (await resolveWritableFormat(fmt)) ?? "";
    if (!fmt) {
      endOperation(s);
      return;
    }
    let volSize: string | undefined;
    let dst: string;
    if (isSplitVolume(s.filePath)) {
      volSize = detectVolumeSize(s.filePath);
      const out = getSplitOutputPath(s.filePath, fmt, "_decrypted");
      dst = out.dst;
    } else {
      dst = uniquePath(s.filePath.slice(0, -ext.length) + "_decrypted." + fmt);
    }
    webview.postMessage({ c: "loading", t: t("archive.decrypting") });
    await convertArchive(s.filePath, fmt, dst, pw, volSize, "", token);
    logger.info({ event: "webview.decrypt.ok", dst });
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
    webview.postMessage({ c: "encState", v: false });
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.decrypt.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
