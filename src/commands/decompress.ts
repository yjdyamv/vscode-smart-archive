/**
 * Decompress command handler — Smart Archiver VSCode Extension
 *
 * Password flow:
 *   - .7z / .zip / .rar → detect encryption first, skip prompt if not encrypted
 *   - All other formats → skip prompt (no encryption support)
 *
 * Cleanup: if extraction fails, the empty output directory
 * is removed to avoid littering the workspace.
 *
 * @module commands/decompress
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { decompressWith7z } from "../engines/js7z-decompress";
import { isEncrypted } from "../engines/js7z-list";
import type { ListEntry } from "../engines/fileListing-core";
import { fetchFileList } from "../providers/fileListing";
import { resolveEffectiveInput } from "../utils/path";
import { promptPassword } from "../ui/prompts";
import { getOutputPath, ensureDirSync } from "../utils/fs";
import {
  DECOMPRESS_EXTENSIONS,
  getFullExt,
  isEncryptableExt,
  resolveSplitVolume,
} from "../constants";
import { isRarExt, isRarVolume, resolveRarVolume, validateRarHeader } from "../utils/rar";
import { openArchivePreview } from "../providers/archiveProvider";
import { t, formatDuration } from "../i18n";
import { logger } from "../utils/logger";
import { promptOversizeFile } from "../utils/promptOversize";
import { isCancellationError } from "../utils/cancellation";

/** Where the extracted contents land. */
export type ExtractMode = "extracted" | "to";

export async function decompressCommand(
  uri: vscode.Uri | undefined,
  selectedUris: readonly vscode.Uri[] | undefined,
): Promise<void> {
  const uris = selectedUris && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  if (uris.length === 0) {
    vscode.window.showErrorMessage(t("decompress.noFile"));
    return;
  }
  let idx = 0;
  for (const fileUri of uris) {
    await decompressSingleFile(fileUri, uris.length > 1 ? ++idx : 0, uris.length);
  }
  logger.info({ event: "decompress.batch.done", mode: "extracted", total: uris.length });
}

/**
 * "Extract to…" — advanced flow. The user picks a destination folder and the
 * archive contents are extracted into it. Unlike the default `<name>.extracted`
 * flow, the target may already hold files, so colliding entries are surfaced
 * and confirmed before anything is overwritten.
 */
export async function decompressToCommand(
  uri: vscode.Uri | undefined,
  selectedUris: readonly vscode.Uri[] | undefined,
): Promise<void> {
  const uris = selectedUris && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  if (uris.length === 0) {
    vscode.window.showErrorMessage(t("decompress.noFile"));
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    title: t("decompress.pickFolderTitle"),
    openLabel: t("decompress.pickFolderLabel"),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(uris[0].fsPath)),
  });
  if (!picked || picked.length === 0) return;
  const destDir = picked[0].fsPath;
  let idx = 0;
  for (const fileUri of uris) {
    await decompressSingleFile(
      fileUri,
      uris.length > 1 ? ++idx : 0,
      uris.length,
      undefined,
      destDir,
    );
  }
  logger.info({ event: "decompress.batch.done", mode: "to", total: uris.length });
}

/**
 * When extracting into an existing folder, list the archive and count the
 * entries that would replace files already on disk. The user may cancel;
 * a listing failure falls back to proceeding (the engine's normal overwrite).
 */
async function confirmDestinationConflicts(
  inputPath: string,
  password: string,
  destDir: string,
): Promise<boolean> {
  let entries: ListEntry[];
  try {
    entries = await fetchFileList(inputPath, password);
  } catch (err) {
    logger.warn(
      { event: "decompress.conflictList.failed", err },
      "Cannot list archive for conflict check, proceeding",
    );
    return true;
  }
  const conflicts = entries.filter((e) => {
    const target = path.join(destDir, e.path);
    if (!fs.existsSync(target)) return false;
    if (e.type === "DIRECTORY") {
      return !fs.statSync(target).isDirectory();
    }
    return true;
  });
  if (conflicts.length === 0) return true;
  const choice = await vscode.window.showWarningMessage(
    t("decompress.conflictMessage", String(conflicts.length)),
    { modal: true },
    t("decompress.overwrite"),
  );
  return choice === t("decompress.overwrite");
}

async function decompressSingleFile(
  uri: vscode.Uri,
  batchIdx: number,
  batchTotal: number,
  knownPassword?: string,
  destOverride?: string,
): Promise<void> {
  const inputPath = uri.fsPath;
  const ext = getFullExt(inputPath);
  const isRar = isRarExt(ext);
  logger.info({ event: "decompress.command.start", inputPath, ext, isRar });

  if (isRarVolume(ext)) {
    const rarPath = resolveRarVolume(inputPath);
    if (rarPath) {
      logger.info({ event: "decompress.rarVolume.redirect", from: inputPath, to: rarPath });
      return decompressSingleFile(
        vscode.Uri.file(rarPath),
        batchIdx,
        batchTotal,
        knownPassword,
        destOverride,
      );
    }
    vscode.window.showErrorMessage(
      t("decompress.failed") + t("decompress.rarVolume", path.basename(inputPath)),
    );
    return;
  }

  // Redirect 7z/zip/wim .002+ → .001 using API
  const effectiveInput = resolveEffectiveInput(inputPath);
  if (effectiveInput !== inputPath) {
    logger.info({ event: "decompress.splitVolume.redirect", from: inputPath, to: effectiveInput });
    return decompressSingleFile(
      vscode.Uri.file(effectiveInput),
      batchIdx,
      batchTotal,
      knownPassword,
      destOverride,
    );
  }

  if (isRarExt(ext)) {
    try {
      validateRarHeader(inputPath);
    } catch (errRar) {
      logger.warn(
        { event: "decompress.validateRar.failed", err: errRar },
        "RAR header validation failed",
      );
      vscode.window.showErrorMessage(t("decompress.failed") + t("decompress.cannotRead"));
      return;
    }
  }

  if (!isRar && !(DECOMPRESS_EXTENSIONS as readonly string[]).includes(ext)) {
    vscode.window.showWarningMessage(t("decompress.unknownFormat", ext));
  }

  // Password: only prompt for encryptable formats that are actually encrypted
  let password = knownPassword ?? "";

  if (!password && isEncryptableExt(ext)) {
    try {
      const encrypted = await isEncrypted(inputPath);
      if (encrypted) {
        const pwd = await promptPassword(t("password.decryptHint"));
        if (pwd === null) return;
        password = pwd;
      }
    } catch {
      logger.warn(
        { event: "decompress.isEncrypted.failed" },
        "Cannot detect encryption, skipping password prompt",
      );
    }
  }

  // "Extract to…" lands in the user-chosen folder; the default keeps the
  // dedicated `<name>.extracted/` subfolder. Only the default is collision-free,
  // so an explicit destination first surfaces any overwrites.
  const outputDir = destOverride ?? getOutputPath(inputPath, "extracted");

  if (destOverride && !(await confirmDestinationConflicts(inputPath, password, destOverride))) {
    return;
  }

  if (!(await promptOversizeFile(path.basename(inputPath), fs.statSync(inputPath).size))) return;

  const batchLabel = batchTotal > 1 ? ` (${batchIdx}/${batchTotal})` : "";
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t("decompress.progressTitle") + batchLabel,
      cancellable: true,
    },
    async (progress, token) => {
      const startTime = Date.now();
      try {
        ensureDirSync(outputDir);
        progress.report({ message: t("archive.extracting") });
        await decompressWith7z(
          { inputPath, outputDir, password, allowOversize: true },
          progress,
          token,
        );
        const elapsed = formatDuration(Date.now() - startTime);
        vscode.window.showInformationMessage(
          t("decompress.done") + outputDir + t("time.elapsed", elapsed),
        );
        logger.info({ event: "decompress.ok", outputDir });
      } catch (err) {
        logger.error({ event: "decompress.extraction.failed", err }, "Decompression failed");
        // Clean up the output directory only when it is ours to clean: the
        // auto-generated `<name>.extracted/` folder, empty after a failure.
        // A user-chosen destination is never touched.
        if (!destOverride) {
          try {
            if (fs.existsSync(outputDir)) {
              const contents = fs.readdirSync(outputDir);
              if (contents.length === 0) {
                fs.rmSync(outputDir, { recursive: true, force: true });
              }
            }
          } catch {
            logger.warn(
              { event: "decompress.cleanup.failed" },
              "Failed to clean up output directory",
            );
          }
        }
        if (!isCancellationError(err)) {
          vscode.window.showErrorMessage(t("decompress.failed") + (err as Error).message);
        }
      }
    },
  );
}

export async function decompressWithKnownPassword(
  uri: vscode.Uri,
  password: string,
): Promise<void> {
  await decompressSingleFile(uri, 0, 0, password);
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

  const splitResolved = resolveSplitVolume(uri.fsPath);
  if (splitResolved) {
    return openArchivePreview(vscode.Uri.file(splitResolved));
  }

  try {
    await openArchivePreview(uri);
    logger.info({ event: "browse.ok", path: uri.fsPath });
  } catch (err) {
    logger.error({ event: "decompress.browse.failed", err }, "Browse command failed");
    vscode.window.showErrorMessage(t("decompress.failed") + (err as Error).message);
  }
}
