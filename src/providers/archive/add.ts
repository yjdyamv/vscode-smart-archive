/**
 * Archive add operations — Smart Archive VSCode Extension
 *
 * Host-side entry points: the webview/picker flow (initAddToArchive /
 * runAddToArchive) and the addToArchive dispatcher. The WASM mutation
 * runs in the worker thread (engines/modify-core); the system-7z fast
 * path stays on the host.
 *
 * @module providers/archive/add
 */

import * as vscode from "vscode";
import { getFullExt, isWrappedFormat, COMPRESS_EXCLUDE_DEFAULTS } from "../../constants";
import { prepareExclusions } from "../../utils/exclude";
import { logger } from "../../utils/logger";
import { t } from "../../i18n";
import { hasSystem7zForFormat, addToArchiveSystem7z } from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";

// ── Per-archive pending state for add-to-archive ──

interface PendingAddState {
  archivePath: string;
  targetDir: string;
  password: string | undefined;
  webview: vscode.Webview | null;
  archiveUri: vscode.Uri | null;
  onComplete?: (webview: vscode.Webview, archiveUri: vscode.Uri, toast?: string) => Promise<void>;
}

const pendingAdds = new Map<string, PendingAddState>();

export function initAddToArchive(
  archivePath: string,
  targetDir: string,
  password: string | undefined,
  webview: vscode.Webview | null,
  archiveUri: vscode.Uri | null,
  onComplete?: (webview: vscode.Webview, archiveUri: vscode.Uri, toast?: string) => Promise<void>,
): void {
  const prev = pendingAdds.get(archivePath);
  if (prev) {
    logger.warn(
      { event: "addToArchive.init.overwritten", prevArchive: archivePath },
      "Pending add state overwritten — previous request was never executed",
    );
    prev.webview?.postMessage({ c: "loading", t: false });
  }
  pendingAdds.set(archivePath, {
    archivePath,
    targetDir,
    password,
    webview,
    archiveUri,
    onComplete,
  });
}

export async function runAddToArchive(): Promise<void> {
  const entries = [...pendingAdds.entries()];
  if (entries.length === 0) {
    logger.warn(
      { event: "addToArchive.run.noCtx" },
      "runAddToArchive called without pending state",
    );
    return;
  }
  const firstKey = entries[0][0];
  const ctx = pendingAdds.get(firstKey)!;
  pendingAdds.delete(firstKey);

  try {
    ctx.webview?.postMessage({ c: "loading", t: true });

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: `$(new-file) ${t("addToArchive.addFiles")}`,
          desc: "files",
          description: t("addToArchive.addFilesDesc"),
        },
        {
          label: `$(new-folder) ${t("addToArchive.addFolders")}`,
          desc: "folders",
          description: t("addToArchive.addFoldersDesc"),
        },
        {
          label: `$(files) ${t("addToArchive.addBoth")}`,
          desc: "both",
          description: t("addToArchive.addBothDesc"),
        },
      ],
      { placeHolder: t("addToArchive.chooseWhat") },
    );
    if (!pick) {
      logger.info({ event: "addToArchive.cancelled", phase: "quickPick" });
      return;
    }

    const uris: vscode.Uri[] = [];

    if (pick.desc === "files" || pick.desc === "both") {
      const furis = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: pick.desc === "both" ? t("addToArchive.selectFiles") : t("addToArchive.select"),
      });
      if (furis) uris.push(...furis);
    }

    if (pick.desc === "folders" || pick.desc === "both") {
      const duris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel:
          pick.desc === "both" ? t("addToArchive.selectFolders") : t("addToArchive.select"),
      });
      if (duris) uris.push(...duris);
    }

    if (uris.length === 0) {
      logger.info({ event: "addToArchive.cancelled", phase: "fileDialog" });
      return;
    }

    const filePaths = uris.map((u) => u.fsPath);
    logger.info({
      event: "addToArchive.start",
      archivePath: ctx.archivePath,
      files: filePaths.length,
      targetDir: ctx.targetDir,
      sample: filePaths.slice(0, 3).join(", "),
    });

    const start = Date.now();
    await addToArchive(ctx.archivePath, filePaths, ctx.targetDir, ctx.password);
    logger.info({
      event: "addToArchive.complete",
      durationMs: Date.now() - start,
      archivePath: ctx.archivePath,
    });

    if (ctx.webview && ctx.archiveUri && ctx.onComplete) {
      await ctx.onComplete(ctx.webview, ctx.archiveUri, t("archive.toastAddedFiles"));
    }
  } catch (err) {
    logger.error({ event: "addToArchive.run.failed", err }, "Add to archive failed");
    if (ctx.webview) ctx.webview.postMessage({ c: "err", t: (err as Error).message });
  } finally {
    ctx.webview?.postMessage({ c: "loading", t: false });
  }
}

/**
 * Add local files/folders to an existing archive at the specified path.
 */
export async function addToArchive(
  archivePath: string,
  localPaths: string[],
  targetDir: string,
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);

  const patterns =
    vscode.workspace.getConfiguration("smart-archive").get<string[]>("compressExcludePatterns") ??
    COMPRESS_EXCLUDE_DEFAULTS;

  // Wrapped formats always mutate via WASM (worker); the system fast path
  // below is only for plain formats.
  if (!isWrappedFormat(ext) && hasSystem7zForFormat(ext) && !password) {
    logger.info({ event: "addToArchive.system7z", archivePath, ext });
    const exclusions = prepareExclusions(patterns);
    await addToArchiveSystem7z(archivePath, localPaths, targetDir, exclusions, password);
    return;
  }

  logger.info({ event: "addToArchive.worker", archivePath, ext });
  await runArchiveOp("modify", {
    action: "add",
    archivePath,
    localPaths,
    targetDir,
    password,
    excludePatterns: patterns,
  });
}
