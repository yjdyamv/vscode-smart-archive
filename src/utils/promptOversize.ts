/**
 * Oversize-file prompt — Smart Archive VSCode Extension
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

function readMaxFileSize(): number {
  const raw = vscode.workspace
    .getConfiguration("smart-archive")
    .get<string | number>("maxFileSize");
  return parseSize(raw, 1024 * 1024 * 1024);
}

/**
 * Prompt the user to confirm extraction of an oversized file.
 * Returns true if the user chooses to continue.
 */
export async function promptOversizeFile(label: string, size: number): Promise<boolean> {
  const maxSize = readMaxFileSize();
  if (size <= maxSize) return true;
  const choice = await vscode.window.showWarningMessage(
    t("security.oversizeWarning", label, fmtSize(size), fmtSize(maxSize)),
    { modal: true },
    t("security.extractAnyway"),
  );
  return choice === t("security.extractAnyway");
}
