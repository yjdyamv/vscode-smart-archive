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
import { decompressWith7z } from "../engines/js7z-engine";
import { extractArchive as extractWithLibarchive } from "../engines/libarchive-engine";
import { promptPassword } from "../ui/prompts";
import { getOutputPath } from "../utils/fs";
import { DECOMPRESS_EXTENSIONS, isRarExt, getFullExt, isEncryptableExt } from "../constants";
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

  if (isRar) {
    try {
      const buf = fs.readFileSync(inputPath, { flag: "r" });
      const magic = buf.toString("ascii", 0, 4);
      if (magic !== "Rar!") {
        vscode.window.showErrorMessage("Not a valid RAR archive (bad header)");
        return;
      }
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
          await tryExtract(
            async () => {
              progress.report({ message: t("archive.extracting") });
              const count = await extractWithLibarchive({ inputPath, outputDir, password }, token);
              const elapsed = formatDuration(Date.now() - startTime);
              vscode.window.showInformationMessage(
                t("decompress.rarDone", String(count)) + outputDir + t("time.elapsed", elapsed),
              );
            },
            async () => {
              progress.report({ message: t("decompress.fallbackTo7z") });
              await decompressWith7z({ inputPath, outputDir, password }, progress, token);
            },
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
        // Clean up on cancellation or failure
        try {
          if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
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
    console.warn("Primary extraction failed:", (primaryErr as Error).message);
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

  try {
    await openArchivePreview(uri);
  } catch (err) {
    vscode.window.showErrorMessage(t("decompress.failed") + (err as Error).message);
  }
}
