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
import { logger } from "./logger";

/**
 * Parse a size string like "100m", "1g", "500k" to bytes.
 * Bare numbers are treated as MiB for backward compatibility.
 * Invalid or zero/negative values fall back to the default.
 */
export function parseSize(raw: string | number | undefined, defaultBytes: number): number {
  if (raw === undefined || raw === null) return defaultBytes;

  // Legacy integer format (MiB)
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      logger.warn(
        { event: "security.parseSize.legacyInvalid", raw },
        "Invalid legacy size, using default",
      );
      return defaultBytes;
    }
    return Math.min(raw * 1024 * 1024, Number.MAX_SAFE_INTEGER);
  }

  const s = String(raw).trim().toLowerCase();
  if (s === "" || s === "0") {
    logger.warn(
      { event: "security.parseSize.empty", raw: s },
      "Empty or zero size config, using default",
    );
    return defaultBytes;
  }

  const m = s.match(/^(\d+(?:\.\d+)?)\s*(k|m|g)$/i);
  if (!m) {
    logger.warn(
      { event: "security.parseSize.invalid", raw: s },
      "Invalid size config format, using default",
    );
    return defaultBytes;
  }

  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) {
    logger.warn(
      { event: "security.parseSize.zero", raw: s },
      "Zero or negative size, using default",
    );
    return defaultBytes;
  }

  const unit = m[2].toLowerCase();
  const multipliers: Record<string, number> = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  const bytes = Math.round(num * multipliers[unit]);

  if (bytes > Number.MAX_SAFE_INTEGER) {
    logger.warn({ event: "security.parseSize.overflow", raw: s, bytes }, "Size too large, capping");
    return Number.MAX_SAFE_INTEGER;
  }

  return bytes;
}

function getLimit(key: string, defaultBytes: number): number {
  const raw = vscode.workspace.getConfiguration("smart-archive").get<string | number>(key);
  return parseSize(raw, defaultBytes);
}

export function getMaxFileSize(): number {
  return getLimit("maxFileSize", 1024 * 1024 * 1024); // 1 GiB default
}

export function getMaxTotalSize(): number {
  return getLimit("maxTotalSize", 10 * 1024 * 1024 * 1024); // 10 GiB default
}

/** Human-readable size string used in dialogs, matching the config format */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Prompt the user to confirm extraction of an oversized file.
 * Returns true if the user chooses to continue.
 */
export async function promptOversizeFile(label: string, size: number): Promise<boolean> {
  const maxSize = getMaxFileSize();
  if (size <= maxSize) return true;
  const choice = await vscode.window.showWarningMessage(
    t("security.oversizeWarning", label, fmtSize(size), fmtSize(maxSize)),
    { modal: true },
    t("security.extractAnyway"),
  );
  return choice === t("security.extractAnyway");
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

  // Reject colon in entry names (Alternate Data Streams on Windows, also
  // problematic on other platforms for cross-archive compatibility)
  if (entryName.includes(":")) {
    throw new Error(`Archive entry contains invalid character ':': ${entryName}`);
  }

  // Strip leading slashes and drive letters (cross-platform).
  // ASCII-only drive-letter regex is sufficient because Windows
  // assigns only A:-Z: as valid drive letters.  A homoglyph
  // (e.g. Cyrillic С:) would not refer to a real drive and is
  // harmless as a path component — the resolved-path check below
  // catches any actual traversal.
  const safe = entryName
    .replace(/^[a-zA-Z]:\\./, "") // Windows drive letter with backslash
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
  if (pw.length > 1024) throw new Error(t("security.passwordTooLong"));
}

/**
 * Sanitize an archive entry name that might be passed as a 7z CLI argument.
 * Prefixes with ./ if the name starts with '-' to prevent flag injection.
 */
export function sanitizeCliPath(entryName: string): string {
  if (entryName.startsWith("-")) return "./" + entryName;
  return entryName;
}

/**
 * Sanitize a target directory path from webview input.
 * Rejects path traversal components (..) and strips leading slashes.
 */
export function sanitizeTargetDir(dir: string): string {
  if (!dir) return "";
  let safe = dir.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = safe.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new Error(t("security.pathTraversal"));
    }
  }
  return safe;
}
