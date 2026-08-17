/**
 * Oversize-file prompt — Smart Archiver VSCode Extension
 *
 * Host-side confirmation dialog for extracting oversized files.
 * Kept out of utils/security (which is vscode-free for worker threads).
 *
 * @module utils/promptOversize
 */

import * as vscode from "vscode";
import { t } from "../i18n";
import { parseSize } from "./security";

/** Human-readable size string used in dialogs, matching the config format */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function readMaxArchiveSize(): number {
  const raw = vscode.workspace
    .getConfiguration("smart-archiver")
    .get<string | number>("limits.maxArchiveSize");
  return parseSize(raw, 1024 * 1024 * 1024);
}

/**
 * Prompt the user to confirm extraction of an oversized archive file.
 * Returns true if the user chooses to continue.
 */
export async function promptOversizeFile(label: string, size: number): Promise<boolean> {
  const maxArchiveSize = readMaxArchiveSize();
  if (size <= maxArchiveSize) return true;
  const choice = await vscode.window.showWarningMessage(
    t("security.oversizeWarning", label, fmtSize(size), fmtSize(maxArchiveSize)),
    { modal: true },
    t("security.extractAnyway"),
  );
  return choice === t("security.extractAnyway");
}
