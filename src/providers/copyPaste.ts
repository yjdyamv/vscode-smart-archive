/**
 * Copy/paste — Smart Archive VSCode Extension
 *
 * Module-level clipboard state for copy-from-archive / paste-to-filesystem.
 *
 * @module providers/copyPaste
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { extractSelected } from "./extraction";
import { cleanupPreviewTemp } from "./tempFiles";
import { t } from "../i18n";
import { logger } from "../utils/logger";

let copiedPaths: string[] | null = null;
let copiedArchivePath = "";
let copiedPassword: string | undefined;
let copiedFlat: boolean | undefined;

export function pasteCopiedFromArchive(): void {
  logger.info({ event: "pasteCopied.enter", pathCount: copiedPaths?.length || 0 });

  if (!copiedPaths || copiedPaths.length === 0 || !copiedArchivePath) {
    vscode.window.showInformationMessage(t("archive.copyNone"));
    return;
  }
  if (!fs.existsSync(copiedArchivePath)) {
    logger.warn({ event: "pasteCopied.sourceMissing", archivePath: copiedArchivePath });
    vscode.window
      .showErrorMessage(t("archive.sourceMissing", copiedArchivePath), "Copy")
      .then((action) => {
        if (action === "Copy")
          vscode.env.clipboard.writeText(t("archive.sourceMissing", copiedArchivePath));
      });
    return;
  }
  const paths = copiedPaths;
  const source = copiedArchivePath;
  const pw = copiedPassword;
  const fl = copiedFlat;
  vscode.window
    .showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: t("archive.pasteHere"),
    })
    .then(async (uris) => {
      if (!uris || uris.length === 0) return;
      try {
        await extractSelected(source, paths, pw, fl, uris[0].fsPath);
        logger.info({
          event: "pasteCopied.success",
          pathCount: paths.length,
          outputDir: uris[0].fsPath,
        });
        cleanupPreviewTemp();
        clearCopiedPaths();
      } catch (err) {
        logger.error({ event: "paste.failed", err }, (err as Error).message);
        vscode.window
          .showErrorMessage(t("decompress.failed") + (err as Error).message, "Copy")
          .then((action) => {
            if (action === "Copy")
              vscode.env.clipboard.writeText(t("decompress.failed") + (err as Error).message);
          });
      }
    });
}

export function setCopiedPaths(
  paths: string[],
  archivePath: string,
  password?: string,
  flat?: boolean,
): void {
  logger.info({ event: "setCopiedPaths", pathCount: paths.length, archivePath, flat });
  copiedPaths = paths;
  copiedArchivePath = archivePath;
  copiedPassword = password;
  copiedFlat = flat;
}

function clearCopiedPaths(): void {
  copiedPaths = null;
  copiedArchivePath = "";
  copiedPassword = undefined;
  copiedFlat = undefined;
}
