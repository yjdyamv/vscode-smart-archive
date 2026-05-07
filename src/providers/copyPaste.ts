/**
 * Copy/paste — Smart Archive VSCode Extension
 *
 * Per-webview clipboard state for copy-from-archive / paste-to-filesystem.
 *
 * @module providers/copyPaste
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { extractSelected } from "./extraction";
import { cleanupPreviewTemp } from "./tempFiles";
import { t } from "../i18n";
import { logger } from "../utils/logger";

interface ClipboardState {
  paths: string[];
  archivePath: string;
  password?: string;
  flat?: boolean;
}

let clipboard: ClipboardState | null = null;

export function pasteCopiedFromArchive(): void {
  logger.info({ event: "pasteCopied.enter", pathCount: clipboard?.paths.length || 0 });

  if (!clipboard || clipboard.paths.length === 0) {
    vscode.window.showInformationMessage(t("archive.copyNone"));
    return;
  }
  const { paths, archivePath: source, password: pw, flat: fl } = clipboard;
  if (!fs.existsSync(source)) {
    logger.warn({ event: "pasteCopied.sourceMissing", archivePath: source });
    vscode.window
      .showErrorMessage(t("archive.sourceMissing", source), t("generic.copy"))
      .then((action) => {
        if (action === t("generic.copy"))
          vscode.env.clipboard.writeText(t("archive.sourceMissing", source));
      });
    return;
  }
  void (async () => {
    try {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: t("archive.pasteHere"),
        title: `${t("archive.pasteHere")} — ${path.basename(source)} (${paths.length} items)`,
      });
      if (!uris || uris.length === 0) return;
      await extractSelected(source, paths, pw, fl, uris[0].fsPath);
      logger.info({
        event: "pasteCopied.success",
        pathCount: paths.length,
        outputDir: uris[0].fsPath,
      });
      cleanupPreviewTemp();
      clearCopiedPaths();
    } catch (err: unknown) {
      logger.error({ event: "pasteCopied.failed", err }, (err as Error).message);
      vscode.window
        .showErrorMessage(t("decompress.failed") + (err as Error).message, t("generic.copy"))
        .then((action) => {
          if (action === t("generic.copy"))
            vscode.env.clipboard.writeText(t("decompress.failed") + (err as Error).message);
        });
    }
  })();
}

export function setCopiedPaths(
  paths: string[],
  archivePath: string,
  password?: string,
  flat?: boolean,
): void {
  if (clipboard && clipboard.archivePath !== archivePath && clipboard.paths.length > 0) {
    logger.warn({
      event: "setCopiedPaths.overwriting",
      prevArchive: clipboard.archivePath,
      newArchive: archivePath,
    });
  }
  logger.info({ event: "setCopiedPaths", pathCount: paths.length, archivePath, flat });
  clipboard = { paths, archivePath, password, flat };
}

function clearCopiedPaths(): void {
  clipboard = null;
}
