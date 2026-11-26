/**
 * Handle password submission from webview.
 *
 * @module providers/webview/handlers/password
 */

import * as vscode from "vscode";
import type { MessageHandler } from "./types";
import { isCancellationError } from "../../../utils/cancellation";
import { logger } from "../../../utils/logger";
import { t, formatCompactSize } from "../../../i18n";
import { isPasswordOrEncryptError } from "../../../utils/errorClassifier";
import { getFullExt, isSplitVolume, isEncryptableExt } from "../../../constants";
import { fetchFileList } from "../../fileListing";
import { saveArchivePassword } from "../../passwordVault";
import { getRarPayloadSizeForSet } from "../../archive/rar5-modify";
import {
  buildTreeRootOnly,
  buildEntryIndex,
  markNoisyDirs,
  countAllStats,
  buildDescendantCounts,
} from "../../treeBuilder";
import { contentHtml, escapeJsonForScript } from "../../htmlRenderer";
import { verifyArchivePassword, pickPasswordProbe } from "./shared";
import { loadExpandedPaths } from "../expandedState";
import { getWebviewUris, getNoisyPatterns } from "../helpers";
import { startOperation, endOperation } from "../state";

export const handlePassword: MessageHandler = async (ctx) => {
  const { webview, state: s, msg } = ctx;
  if (!msg.pw) return;
  logger.info({ event: "webview.password.attempt" });
  const token = startOperation(s);
  try {
    const pwEntries = await fetchFileList(s.filePath, msg.pw);
    if (pwEntries.length === 0) {
      webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
      return;
    }

    if (token.isCancellationRequested) throw new vscode.CancellationError();

    logger.info({ event: "webview.password.ok", count: pwEntries.length });

    // Prove the password by decrypting a few KB of one member. Listing alone
    // cannot do it: for archives we create the headers are encrypted, so a
    // wrong password yields an empty listing (caught above), but a third-party
    // archive with unencrypted headers lists fine under any password.
    //
    // The probe reads only the first block, so unlike the old whole-archive
    // `7z t` (22 s for 139 MB, past its 15 s timeout — it rejected *correct*
    // passwords) its cost does not grow with the archive or with the size of
    // the smallest member. A full integrity test is still a user action: the
    // ✓ button in the status bar, which runs with progress and no timeout.
    if (!(await verifyArchivePassword(s.filePath, msg.pw, pickPasswordProbe(pwEntries)))) {
      webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
      return;
    }

    // Commit the password to shared state only once it is proven correct, so
    // a failed probe never poisons later extract/preview/test operations.
    s.password = msg.pw;

    // Remember the password for this session (OS keychain), so re-opening the
    // archive after closing the tab skips the prompt.
    await saveArchivePassword(s.filePath, msg.pw);

    if (token.isCancellationRequested) throw new vscode.CancellationError();

    s.entries = pwEntries;
    s.entryIndex = buildEntryIndex(pwEntries);
    const pwTree = buildTreeRootOnly(pwEntries, s.archiveName);
    const descCounts = buildDescendantCounts(pwEntries);
    markNoisyDirs(pwTree, getNoisyPatterns());
    const pwStats = countAllStats(pwEntries);
    const ext = getFullExt(s.filePath);
    const pwToast =
      [".deb", ".rpm"].includes(ext) || isSplitVolume(s.filePath)
        ? t("archive.readOnly")
        : undefined;
    const { cssUri, jsUri, codiconCssUri } = getWebviewUris(webview);
    webview.html = contentHtml(
      pwTree,
      pwStats.files,
      pwStats.dirs,
      cssUri,
      jsUri,
      codiconCssUri,
      {
        name: s.archiveName,
        format: ext,
        count: pwStats.total,
        size: formatCompactSize(pwStats.totalSize),
        // Exclude the recovery-record parity tails (per volume) from the ratio.
        ratio: pwStats.totalSize > 0 ? getRarPayloadSizeForSet(s.filePath) / pwStats.totalSize : 0,
      },
      getNoisyPatterns(),
      pwToast,
    );
    const extra: string[] = [];
    if (isSplitVolume(s.filePath)) {
      extra.push(`<script type="application/json" id="_xIsSplit">true</script>`);
    }
    if ([".7z", ".zip"].includes(ext) && !isSplitVolume(s.filePath)) {
      extra.push(`<script type="application/json" id="_xCanSplit">true</script>`);
    }
    extra.push(`<script type="application/json" id="_xIsEncrypted">true</script>`);
    if (isEncryptableExt(ext))
      extra.push(`<script type="application/json" id="_xCanEncrypt">true</script>`);
    const descObj = Object.create(null) as Record<string, { files: number; dirs: number }>;
    for (const [k, v] of descCounts) descObj[k] = v;
    extra.push(
      `<script type="application/json" id="_xDescCounts">${escapeJsonForScript(JSON.stringify(descObj))}</script>`,
    );
    const persisted = await loadExpandedPaths(s.archiveUri, true);
    if (persisted.length > 0) {
      extra.push(
        `<script type="application/json" id="_xExpanded">${escapeJsonForScript(JSON.stringify(persisted))}</script>`,
      );
    }
    if (extra.length > 0) {
      webview.html = webview.html.replace("</body>", extra.join("") + "</body>");
    }
  } catch (err) {
    if (isCancellationError(err)) return;
    logger.error({ event: "webview.password.failed", err });
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isPasswordOrEncryptError(errMsg)) {
      webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
    } else {
      webview.postMessage({ c: "err", t: errMsg });
    }
  } finally {
    endOperation(s);
  }
};
