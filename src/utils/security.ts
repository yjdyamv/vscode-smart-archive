/**
 * Security utilities — Smart Archiver VSCode Extension
 *
 * Protects against common archive-based attacks:
 *   - Zip Slip (path traversal via ../ in entry names)
 *   - Symlink escape (archives containing out-of-tree symlinks)
 *   - Entry name sanitization (leading slashes, null bytes)
 *
 * Vscode-free: size limits are injected via setSecurityLimits (host reads
 * workspace config; worker threads receive them in the init message).
 *
 * @module utils/security
 */

import * as path from "path";
import { t } from "../i18n";
import { DEFAULT_MAX_ARCHIVE_SIZE, DEFAULT_MAX_EXTRACT_TOTAL_SIZE } from "../constants";
import { logger } from "./logger-core";

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

export interface SecurityLimits {
  /** Compressed archive file itself (including split volumes). Only enforced
   *  when the whole archive must be loaded into memory (WASM fallback). */
  maxArchiveSize?: number;
  /** Total size of all files after one extraction operation. */
  maxExtractTotalSize?: number;
}

let _limits: SecurityLimits = {};

/**
 * Inject the configured size limits. Host calls this at activation and on
 * configuration change; worker threads receive the same values at init.
 */
export function setSecurityLimits(limits: SecurityLimits): void {
  _limits = limits;
}

function getMaxArchiveSize(): number {
  return _limits.maxArchiveSize ?? DEFAULT_MAX_ARCHIVE_SIZE;
}

function getMaxExtractTotalSize(): number {
  return _limits.maxExtractTotalSize ?? DEFAULT_MAX_EXTRACT_TOTAL_SIZE;
}

/** Human-readable size string used in dialogs, matching the config format */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Error thrown when the compressed archive file itself exceeds the configured
 * archive-size limit.
 */
export class OversizeArchiveError extends Error {
  readonly size: number;
  readonly max: number;

  constructor(size: number, max: number) {
    super(t("security.archiveSizeExceeded", fmtSize(size), fmtSize(max)));
    this.name = "OversizeArchiveError";
    this.size = size;
    this.max = max;
  }
}

/** True for archive-size errors, including errors cloned across worker threads. */
export function isOversizeError(err: unknown): err is OversizeArchiveError {
  return (
    err instanceof OversizeArchiveError ||
    (err instanceof Error && err.name === "OversizeArchiveError")
  );
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
 * Check that a compressed archive file (including split volumes) does not
 * exceed the configured archive-size limit.
 */
export function checkArchiveSize(size: number): void {
  const max = getMaxArchiveSize();
  if (size > max) {
    throw new OversizeArchiveError(size, max);
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
  const max = getMaxExtractTotalSize();
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
  if (entryName.startsWith("-") || entryName.startsWith("@")) return "./" + entryName;
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

/**
 * Validate an archive entry path coming from the webview (defense in
 * depth — a crafted message must not drive filesystem operations with
 * "", ".", "..", absolute, or native-separator paths).
 *
 * Entry paths use "/" separators and are relative. Tolerated shapes:
 *   - a leading "./" prefix (7z listings may emit it),
 *   - a single trailing "/" (directory entries in some listings).
 * Rejected: empty string, absolute paths (leading "/" or drive letter),
 * backslashes, any ".." segment, "." segments except the leading "./"
 * prefix, empty segments elsewhere ("a//b"), and overlong paths.
 */
export function isValidArchivePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return false;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  if (p.includes("\\")) return false;
  const segments = p.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "..") return false;
    if (seg === "") {
      // Only a trailing empty segment ("dir/") is tolerated.
      if (i !== segments.length - 1) return false;
      continue;
    }
    if (seg === ".") {
      // Only the leading "./" prefix is tolerated.
      if (!(i === 0 && segments.length > 1)) return false;
      continue;
    }
  }
  return true;
}

/**
 * Validate an archive entry NAME (rename / new-folder input), as opposed
 * to a path: a single segment, no separators, not "." or "..", no Windows
 * reserved characters, and a sane length. Trailing dots are rejected too
 * (Windows silently strips them, making "foo." and "foo" collide).
 */
export function isValidEntryName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  if (/[<>:"/\\|?*]/.test(name)) return false;
  if (name.endsWith(".") || name.endsWith(" ")) return false;
  return true;
}
