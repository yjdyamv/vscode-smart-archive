/**
 * Rebuild-volumes command — Smart Archiver VSCode Extension
 *
 * Rebuilds missing volumes of a multi-volume RAR5 set from its `.rev`
 * recovery volumes (WinRAR's `rar rc` equivalent, backed by the rar5
 * native binding). The user picks the first volume (`name.part1.rar`);
 * every missing `partN.rar` is reconstructed in place.
 *
 * @module commands/rebuildVolumes
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { rebuildMissingVolumesWithRar5 } from "../engines/rar5-engine";
import { isRarExt } from "../utils/rar";
import { getFullExt } from "../constants";
import { logger } from "../utils/logger";
import { t } from "../i18n";

/** Volume numbers missing from the set (gaps between .part1.rar and the last present volume). */
function missingVolumeNumbers(firstVolume: string): number[] {
  const dir = path.dirname(firstVolume);
  const base = path.basename(firstVolume).replace(/\.part1\.rar$/i, "");
  const present = new Set<number>();
  let max = 1;
  const pattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.part(\\d+)\\.rar$`,
    "i",
  );
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(pattern);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    present.add(n);
    if (n > max) max = n;
  }
  const missing: number[] = [];
  for (let n = 1; n <= max; n++) {
    if (!present.has(n)) missing.push(n);
  }
  return missing;
}

export async function rebuildVolumesCommand(uri?: vscode.Uri): Promise<void> {
  let firstVolume: string | undefined = uri?.fsPath;
  if (!firstVolume) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { RAR: ["rar"] },
      openLabel: t("rebuildVolumes.pick"),
      title: t("rebuildVolumes.title"),
    });
    firstVolume = picked?.[0]?.fsPath;
  }
  if (!firstVolume) return;

  const ext = getFullExt(firstVolume);
  if (!isRarExt(ext)) {
    vscode.window.showErrorMessage(t("rebuildVolumes.failed") + t("rar5.modifyNotRar"));
    return;
  }
  if (!/\.part1\.rar$/i.test(firstVolume)) {
    vscode.window.showErrorMessage(t("rebuildVolumes.needPart1"));
    return;
  }

  let missing: number[];
  try {
    missing = missingVolumeNumbers(firstVolume);
  } catch (err) {
    vscode.window.showErrorMessage(
      t("rebuildVolumes.failed") + (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  if (missing.length === 0) {
    vscode.window.showInformationMessage(t("rebuildVolumes.nothingMissing"));
    return;
  }

  const dir = path.dirname(firstVolume);
  const revs = fs
    .readdirSync(dir)
    .filter((n) => /\.part\d+\.rev$/i.test(n) || /\.rev\d+\.rev$/i.test(n));
  if (revs.length === 0) {
    vscode.window.showWarningMessage(t("rebuildVolumes.noRecovery"));
    return;
  }

  const base = path.basename(firstVolume).replace(/\.part1\.rar$/i, "");
  const list = missing.map((n) => `${base}.part${n}.rar`).join(", ");
  const confirm = await vscode.window.showWarningMessage(
    t("rebuildVolumes.confirm", list),
    { modal: true },
    t("rebuildVolumes.rebuild"),
  );
  if (confirm !== t("rebuildVolumes.rebuild")) return;

  try {
    const rebuilt = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t("rebuildVolumes.title"),
        cancellable: false,
      },
      async () => {
        // Synchronous binding call; the set is small (parity streams only).
        return rebuildMissingVolumesWithRar5(firstVolume!);
      },
    );
    logger.info({ event: "rebuildVolumes.done", firstVolume, rebuilt: rebuilt.length });
    const open = await vscode.window.showInformationMessage(
      t("rebuildVolumes.done", String(rebuilt.length)),
      "Open",
    );
    if (open) {
      await vscode.commands.executeCommand(
        "yjdyamv.smart-archiver.browse",
        vscode.Uri.file(firstVolume),
      );
    }
  } catch (err) {
    logger.error({ event: "rebuildVolumes.failed", firstVolume, err });
    vscode.window.showErrorMessage(
      t("rebuildVolumes.failed") + (err instanceof Error ? err.message : String(err)),
    );
  }
}
