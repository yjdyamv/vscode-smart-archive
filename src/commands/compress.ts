/**
 * Compress command handler — Smart Archive VSCode Extension
 *
 * Orchestrates the compression workflow:
 *   format selection → auto-wrap → encryption → password → save → execute
 *
 * Stream formats (gz/bz2/xz) are single-file only. When the user selects
 * a folder or multiple files, we auto-upgrade to tar.gz/tar.bz2/tar.xz
 * to preserve directory structure.
 *
 * @module commands/compress
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { compressWith7z } from "../engines/js7z-engine";
import { COMPRESS_EXCLUDE_DEFAULTS } from "../constants";
import { cleanupTmpFiles } from "../engines/js7z-helpers";
import {
  promptCompressFormat,
  promptEncryptChoice,
  promptPassword,
  promptSavePath,
  promptCompressLevel,
} from "../ui/prompts";
import type { CompressOptions } from "../types";
import { t } from "../i18n";
import { logger } from "../utils/logger";

export async function compressCommand(
  uri: vscode.Uri | undefined,
  selectedUris: readonly vscode.Uri[] | undefined,
): Promise<void> {
  const targets = selectedUris && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  if (targets.length === 0) {
    vscode.window.showErrorMessage(t("compress.noFiles"));
    return;
  }

  // Validate all targets exist before showing any prompts
  for (const target of targets) {
    if (!fs.existsSync(target.fsPath)) {
      vscode.window.showErrorMessage(t("compress.noFiles") + target.fsPath);
      return;
    }
  }

  const format = await promptCompressFormat();
  if (!format) return;

  if (!format.canCreate) {
    vscode.window.showInformationMessage(t("compress.rarUnsupported"));
    return;
  }

  const level = await promptCompressLevel();

  if (format.supportsEncryption) {
    const encryptChoice = await promptEncryptChoice();
    if (encryptChoice === null) return;
    if (encryptChoice) {
      const pwd = await promptPassword(t("password.encryptHint"));
      if (pwd === null) return;
      if (!pwd) {
        vscode.window.showWarningMessage(t("encrypt.noPassword"));
      }
      return executeCompress(targets, format, pwd, format.label, level);
    }
  }

  await executeCompress(targets, format, "", format.label, level);
}

async function executeCompress(
  targets: readonly vscode.Uri[],
  format: { label: string; supportsEncryption: boolean; canCreate: boolean },
  password: string,
  outputExtension: string,
  level: number,
): Promise<void> {
  const firstTarget = targets[0];
  const saveUri = await promptSavePath(firstTarget.fsPath, targets.length, outputExtension);
  if (!saveUri) return;

  const options: CompressOptions = {
    targets: targets.map((target) => ({ fsPath: target.fsPath })),
    format: {
      label: format.label,
      description: "",
      canCreate: format.canCreate,
      supportsEncryption: format.supportsEncryption,
    },
    outputPath: saveUri.fsPath,
    password,
    level,
  };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t("compress.progressTitle"),
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const userPatterns: string[] | undefined = vscode.workspace
          .getConfiguration("smart-archive")
          .get("compressExcludePatterns");
        const excludePatterns = [
          ...new Set([...COMPRESS_EXCLUDE_DEFAULTS, ...(userPatterns ?? [])]),
        ];
        await compressWith7z(options, progress, token, excludePatterns);
      } catch (err) {
        logger.error({ event: "compress.command.failed", err }, "Compression failed");
        cleanupTmpFiles(options.outputPath);
        try {
          if (fs.existsSync(options.outputPath)) {
            fs.unlinkSync(options.outputPath);
          }
        } catch {
          logger.warn(
            { event: "compress.cleanup.failed" },
            "Failed to clean up partial output file",
          );
        }
        if (!(err instanceof vscode.CancellationError)) {
          vscode.window.showErrorMessage(t("compress.failed") + (err as Error).message);
        }
      }
    },
  );
}
