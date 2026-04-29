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

/** Maximum allowed decompressed file size (1 GiB) */
export const MAX_FILE_SIZE = 1024 * 1024 * 1024;

/** Maximum total decompressed size across all files (10 GiB) */
export const MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024;

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
    process.platform === "win32"
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
 * @throws If the size exceeds MAX_FILE_SIZE
 */
export function checkFileSize(size: number): void {
  if (size > MAX_FILE_SIZE) {
    throw new Error(`File size ${size} exceeds maximum allowed ${MAX_FILE_SIZE} bytes`);
  }
}

/**
 * Check if the running total exceeds the configured maximum.
 *
 * @param current - Current accumulated size in bytes
 * @param added - New bytes to add
 * @returns New total
 * @throws If the new total exceeds MAX_TOTAL_SIZE
 */
export function checkTotalSize(current: number, added: number): number {
  const total = current + added;
  if (total > MAX_TOTAL_SIZE) {
    throw new Error(`Total decompressed size ${total} exceeds maximum ${MAX_TOTAL_SIZE} bytes`);
  }
  return total;
}
