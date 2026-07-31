/**
 * Handle encrypt-archive from webview.
 *
 * @module providers/webview/handlers/encrypt
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { getFullExt, isSplitVolume } from "../../../constants";
import { ArchiveService } from "../../../services/archiveService";
import { startOperation, endOperation } from "../state";
import { uniquePath } from "../helpers";
import { pwInputBox, resolveWritableFormat, detectVolumeSize, getSplitOutputPath } from "./shared";

export const handleEncrypt: MessageHandler = async (ctx) => {
  const { webview, state: s } = ctx;
  logger.info({ event: "webview.encrypt", path: s.filePath });
  const token = startOperation(s);
  try {
    const newPw = await pwInputBox(t("archive.encryptPrompt"), (v) =>
      v ? undefined : t("security.passwordEmpty"),
    );
    if (!newPw) {
      endOperation(s);
      return;
    }
    const confirmPw = await pwInputBox(t("archive.encryptConfirm"));
    if (!confirmPw) {
      endOperation(s);
      return;
    }
    if (confirmPw !== newPw) {
      vscode.window.showErrorMessage(t("validation.passwordMismatch"));
      endOperation(s);
      return;
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
      const out = getSplitOutputPath(s.filePath, fmt, "_encrypted");
      dst = out.dst;
    } else {
      dst = uniquePath(s.filePath.slice(0, -ext.length) + "_encrypted." + fmt);
    }
    webview.postMessage({ c: "loading", t: t("archive.encrypting") });
    await ArchiveService.convert(s.filePath, fmt, dst, s.password ?? "", volSize, newPw, token);
    logger.info({ event: "webview.encrypt.complete", dst });
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
    webview.postMessage({ c: "encState", v: true });
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.encrypt.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
    endOperation(s);
  }
};
