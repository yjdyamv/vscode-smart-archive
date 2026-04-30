/**
 * Decompress command handler — Smart Archive VSCode Extension
 *
 * Password flow:
 *   - .7z / .zip / .rar → always prompt (these can be encrypted)
 *   - All other formats → skip prompt (no encryption support)
 *
 * Cleanup: if extraction fails (both engines), the empty output directory
 * is removed to avoid littering the workspace.
 *
 * @module commands/decompress
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { decompressWith7z } from "../engines/js7z-engine";
import { extractArchive as extractWithLibarchive } from "../engines/libarchive-engine";
import { promptPassword } from "../ui/prompts";
import { getOutputPath } from "../utils/fs";
import { DECOMPRESS_EXTENSIONS, getFullExt, isEncryptableExt } from "../constants";
import { isRarExt, isRarVolume, resolveRarVolume, validateRarHeader } from "../utils/rar";
import { openArchivePreview } from "../providers/archiveProvider";
import { t, formatDuration } from "../i18n";
import { logger } from "../utils/logger";

export async function decompressCommand(
  uri: vscode.Uri | undefined,
  _selectedUris: readonly vscode.Uri[] | undefined,
): Promise<void> {
  if (!uri) {
    vscode.window.showErrorMessage(t("decompress.noFile"));
    return;
  }

  const inputPath = uri.fsPath;
  const ext = getFullExt(inputPath);
  const isRar = isRarExt(ext);
  logger.info({ event: "decompress.command.start", inputPath, ext, isRar });

  if (isRarVolume(ext)) {
    const rarPath = resolveRarVolume(inputPath);
    if (rarPath) {
      logger.info({ event: "decompress.rarVolume.redirect", from: inputPath, to: rarPath });
      return decompressCommand(vscode.Uri.file(rarPath), undefined);
    }
    vscode.window.showErrorMessage(
      t("decompress.failed") +
        `Multi-volume RAR: "${path.basename(inputPath)}" requires a .rar file in the same directory.`,
    );
    return;
  }

  if (isRarExt(ext)) {
    try {
      validateRarHeader(inputPath);
    } catch {
      vscode.window.showErrorMessage(t("decompress.failed") + "Cannot read file");
      return;
    }
  }

  if (!isRar && !(DECOMPRESS_EXTENSIONS as readonly string[]).includes(ext)) {
    vscode.window.showWarningMessage(t("decompress.unknownFormat", ext));
  }

  // Password: always prompt for encryptable formats, skip for others
  let password = "";

  if (isEncryptableExt(ext)) {
    const pwd = await promptPassword(t("password.decryptHint"));
    if (pwd === null) return;
    password = pwd;
  }

  const outputDir = getOutputPath(inputPath, "extracted");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: isRar ? t("decompress.rarProgressTitle") : t("decompress.progressTitle"),
      cancellable: true,
    },
    async (progress, token) => {
      const startTime = Date.now();
      // Only create output dir when extraction starts; clean up on failure
      try {
        fs.mkdirSync(outputDir, { recursive: true });

        if (isRar) {
          progress.report({ message: t("archive.extracting") });
          const count = await extractWithLibarchive({ inputPath, outputDir, password }, token);
          const elapsed = formatDuration(Date.now() - startTime);
          vscode.window.showInformationMessage(
            t("decompress.rarDone", String(count)) + outputDir + t("time.elapsed", elapsed),
          );
        } else {
          await tryExtract(
            () => decompressWith7z({ inputPath, outputDir, password }, progress, token),
            async () => {
              progress.report({ message: t("decompress.fallbackToLA") });
              const count = await extractWithLibarchive({ inputPath, outputDir, password }, token);
              const elapsed = formatDuration(Date.now() - startTime);
              vscode.window.showInformationMessage(
                t("decompress.rarDone", String(count)) + outputDir + t("time.elapsed", elapsed),
              );
            },
          );
        }
      } catch (err) {
        // Clean up output directory only if it's empty (partial extraction
        // may have succeeded; deleting non-empty dir would destroy valid data)
        try {
          if (fs.existsSync(outputDir)) {
            const contents = fs.readdirSync(outputDir);
            if (contents.length === 0) {
              fs.rmdirSync(outputDir);
            }
          }
        } catch {
          /* best-effort cleanup */
        }
        if (!(err instanceof vscode.CancellationError)) {
          vscode.window.showErrorMessage(t("decompress.failed") + (err as Error).message);
        }
      }
    },
  );
}

async function tryExtract(
  primary: () => Promise<void>,
  fallback: () => Promise<void>,
): Promise<void> {
  try {
    await primary();
  } catch (primaryErr) {
    logger.warn(
      { event: "decompress.primary.failed", err: primaryErr },
      "Primary extraction failed, falling back to libarchive",
    );
    try {
      await fallback();
    } catch (fallbackErr) {
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        t("decompress.failed") +
          `\n7z: ${(primaryErr as Error).message}\nlibarchive: ${(fallbackErr as Error).message}`,
      );
    }
  }
}

export async function browseCommand(uri: vscode.Uri | undefined): Promise<void> {
  if (!uri) {
    vscode.window.showErrorMessage(t("decompress.noFile"));
    return;
  }

  const rarPath = resolveRarVolume(uri.fsPath);
  if (rarPath) {
    return openArchivePreview(vscode.Uri.file(rarPath));
  }

  try {
    await openArchivePreview(uri);
  } catch (err) {
    vscode.window.showErrorMessage(t("decompress.failed") + (err as Error).message);
  }
}
