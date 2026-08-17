/**
 * Repair command — Smart Archiver VSCode Extension
 *
 * Repairs a damaged RAR5 archive using its inline recovery record
 * (WinRAR's `rar r` equivalent, backed by the rar5 native binding).
 *
 * @module commands/repair
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { repairWithRar5 } from "../engines/rar5-engine";
import { isRarExt } from "../utils/rar";
import { getFullExt } from "../constants";
import { logger } from "../utils/logger";
import { t } from "../i18n";

/** Strip a RAR5 volume suffix (".partN.rar") so the repaired name is clean. */
function repairOutputPath(archivePath: string): string {
  const dir = path.dirname(archivePath);
  const base = path.basename(archivePath).replace(/\.part\d+\.rar$/i, "");
  const stem = base.replace(/\.rar$/i, "");
  return path.join(dir, `${stem}_repaired.rar`);
}

export async function repairCommand(uri?: vscode.Uri): Promise<void> {
  let archivePath: string | undefined = uri?.fsPath;
  if (!archivePath) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { RAR: ["rar"] },
      openLabel: t("repair.title"),
      title: t("repair.pick"),
    });
    archivePath = picked?.[0]?.fsPath;
  }
  if (!archivePath) return;

  const ext = getFullExt(archivePath);
  if (!isRarExt(ext)) {
    vscode.window.showErrorMessage(t("repair.failed") + t("rar5.modifyNotRar"));
    return;
  }

  const outputPath = repairOutputPath(archivePath);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t("repair.title"),
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: t("rar5.modifyExtracting") });
        await new Promise<void>((resolve, reject) => {
          try {
            repairWithRar5(archivePath!, outputPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    const size = fs.statSync(outputPath).size;
    logger.info({ event: "repair.done", archivePath, outputPath, size });
    const open = await vscode.window.showInformationMessage(t("repair.done") + outputPath, "Open");
    if (open) {
      await vscode.commands.executeCommand(
        "yjdyamv.smart-archiver.browse",
        vscode.Uri.file(outputPath),
      );
    }
  } catch (err) {
    logger.error({ event: "repair.failed", archivePath, err });
    vscode.window.showErrorMessage(
      t("repair.failed") + (err instanceof Error ? err.message : String(err)),
    );
  }
}
