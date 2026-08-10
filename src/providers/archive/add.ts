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
import { getFullExt, COMPRESS_EXCLUDE_DEFAULTS } from "../../constants";
import { prepareExclusions } from "../../utils/exclude";
import { logger } from "../../utils/logger";
import { t } from "../../i18n";
import { addToArchiveSystem7z } from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";
import { selectEngine } from "../../engines/select-engine";
import { appendWithRar5 } from "../../engines/rar5-engine";
import {
  rebuildRarArchive,
  archiveJoin,
  copyIntoArchive,
  detectRarVersion,
} from "./rar5-modify";
import { isRarVolume } from "../../utils/rar";

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
      event: "addToArchive.ok",
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

  const { engine } = selectEngine({ op: "add", ext, password });

  // 7-Zip cannot add files to RAR archives (E_NOTIMPL) — for single-volume
  // RAR5 archives the rar5 binding appends without rebuilding (existing
  // members keep their exact bytes); anything else falls back to a full
  // rebuild.
  if (engine === "rarRebuild") {
    const multiVolume = isRarVolume(ext) || /\.part\d+\.rar$/i.test(archivePath);
    if (!multiVolume && detectRarVersion(archivePath) === "rar5") {
      try {
        logger.info({
          event: "addToArchive.rar5.append",
          archivePath,
          files: localPaths.length,
          targetDir,
        });
        await appendWithRar5(archivePath, localPaths, targetDir, password ?? "", patterns);
        return;
      } catch (err) {
        logger.warn(
          { event: "addToArchive.rar5.append.failed", archivePath, err },
          "Append failed, falling back to full rebuild",
        );
      }
    }
    logger.info({
      event: "addToArchive.rar5.rebuild",
      archivePath,
      files: localPaths.length,
      targetDir,
    });
    const exclusions = prepareExclusions(patterns);
    await rebuildRarArchive({
      archivePath,
      password,
      mutate: (root) => {
        const destDir = targetDir ? archiveJoin(root, targetDir) : root;
        for (const lp of localPaths) {
          copyIntoArchive(destDir, lp, exclusions);
        }
      },
    });
    return;
  }

  if (engine === "system7z") {
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
