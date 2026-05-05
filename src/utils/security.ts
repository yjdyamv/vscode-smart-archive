/**
 * Security utilities — Smart Archive VSCode Extension
 *
 * Protects against common archive-based attacks:
 *   - Zip Slip (path traversal via ../ in entry names)
 *   - Symlink escape (archives containing out-of-tree symlinks)
 *   - Entry name sanitization (leading slashes, null bytes)
 *
 * @module utils/security
 */

import * as path from "path";
import * as vscode from "vscode";
import { t } from "../i18n";

function getLimit(key: string, defaultMiB: number): number {
  return (
    vscode.workspace.getConfiguration("smart-archive").get<number>(key, defaultMiB) * 1024 * 1024
  );
}

export function getMaxFileSize(): number {
  return getLimit("maxFileSizeMiB", 1024);
}

export function getMaxTotalSize(): number {
  return getLimit("maxTotalSizeMiB", 10240);
}

/** Human-readable size string used in dialogs */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const k = 1024;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Prompt the user to confirm extraction of an oversized file.
 * Returns true if the user chooses to continue.
 */
export async function promptOversizeFile(label: string, size: number): Promise<boolean> {
  const maxSize = getMaxFileSize();
  if (size <= maxSize) return true;
  const choice = await vscode.window.showWarningMessage(
    `"${label}" is ${fmtSize(size)}, exceeding the limit of ${fmtSize(maxSize)}.\n\nExtracting may cause high memory usage or disk exhaustion.`,
    { modal: true },
    "Extract anyway",
  );
  return choice === "Extract anyway";
}

/**
 * Sanitize and validate an archive entry path against Zip Slip attacks.
 *
 * Ensures the resolved path stays within the designated output directory
 * and contains no dangerous components (../, absolute paths, null bytes).
 *
 * @param outputDir - The designated extraction root directory
 * @param entryName - The raw pathname from the archive entry
 * @returns The sanitized, absolute output path for the entry
 * @throws If the path attempts to escape the output directory
 */
export function safeJoinPath(outputDir: string, entryName: string): string {
  // Reject null bytes (path truncation attack)
  if (entryName.includes("\0")) {
    throw new Error(`Archive entry contains null byte: ${entryName}`);
  }

  // Reject excessively long paths (DOS / filesystem limits)
  if (entryName.length > 4096) {
    throw new Error(`Archive entry path too long (${entryName.length} chars)`);
  }

  // Reject Windows Alternate Data Streams (e.g., file.txt:evil)
  if (process.platform === "win32" && entryName.includes(":")) {
    throw new Error(`Archive entry contains invalid character ':' (ADS): ${entryName}`);
  }

  // Strip leading slashes and drive letters (cross-platform)
  const safe = entryName
    .replace(/^[a-zA-Z]:\\/, "") // Windows drive letter with backslash
    .replace(/^[a-zA-Z]:/, "") // Windows drive letter (no backslash)
    .replace(/^\/+/, ""); // Unix absolute path

  // Normalize and resolve against output directory
  const resolved = path.resolve(outputDir, safe);

  // Ensure the resolved path is within the output directory
  // Case-insensitive comparison on Windows (NTFS is case-insensitive)
  const normalizedOutput = path.resolve(outputDir) + path.sep;
  const within =
    process.platform === "win32" || process.platform === "darwin"
      ? resolved.toLowerCase().startsWith(normalizedOutput.toLowerCase())
      : resolved.startsWith(normalizedOutput);

  if (!within && resolved !== path.resolve(outputDir)) {
    throw new Error(`Path traversal blocked: "${entryName}" resolves outside output directory`);
  }

  return resolved;
}

/**
 * Check if a file size exceeds the configured maximum.
 *
 * @param size - File size in bytes
 * @throws If the size exceeds the configured limit
 */
export function checkFileSize(size: number): void {
  const max = getMaxFileSize();
  if (size > max) {
    throw new Error(t("security.fileSizeExceeded", fmtSize(size), fmtSize(max)));
  }
}

/**
 * Check if the running total exceeds the configured maximum.
 *
 * @param current - Current accumulated size in bytes
 * @param added - New bytes to add
 * @returns New total
 * @throws If the new total exceeds the configured limit
 */
export function checkTotalSize(current: number, added: number): number {
  const total = current + added;
  const max = getMaxTotalSize();
  if (total > max) {
    throw new Error(t("security.totalSizeExceeded", fmtSize(total), fmtSize(max)));
  }
  return total;
}

/**
 * Validate password for safe use in 7z CLI arguments.
 * Rejects passwords starting with '-' (could be parsed as flags),
 * containing null bytes, newlines, or invalid characters.
 * Also limits password to a reasonable maximum length.
 */
export function validatePassword(pw: string): void {
  if (pw.startsWith("-")) throw new Error(t("security.passwordStartDash"));
  if (pw.includes("\0")) throw new Error(t("security.passwordNullByte"));
  if (pw.includes("\n") || pw.includes("\r")) throw new Error(t("security.passwordNewline"));
  if (pw.length > 1024) throw new Error("Password too long (max 1024 characters)");
}

/**
 * Sanitize an archive entry name that might be passed as a 7z CLI argument.
 * Prefixes with ./ if the name starts with '-' to prevent flag injection.
 */
export function sanitizeCliPath(entryName: string): string {
  if (entryName.startsWith("-")) return "./" + entryName;
  return entryName;
}
