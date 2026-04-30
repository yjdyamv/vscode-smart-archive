/**
 * RAR archive utilities — Smart Archive VSCode Extension
 *
 * RAR is handled exclusively by libarchive-wasm (js7z-tools cannot read RAR).
 * This module centralizes all RAR-specific detection, validation, and
 * multi-volume resolution logic that was previously scattered across
 * constants.ts, decompress.ts, and archiveProvider.ts.
 *
 * @module utils/rar
 */

import * as fs from "fs";

/** Matches .rar and multi-volume parts .r00–.r99 */
const RAR_PATTERN = /^\.(?:rar|r\d{2})$/i;

/** Matches only headerless volume parts .r00–.r99 (not .rar itself) */
const RAR_VOLUME_RE = /^\.r\d{2}$/i;

/**
 * Returns true if the extension is any RAR-family file (.rar or .r00–.r99).
 */
export function isRarExt(ext: string): boolean {
  return RAR_PATTERN.test(ext);
}

/**
 * Returns true if the extension is a RAR volume part (.r00–.r99),
 * which cannot be extracted on its own (headerless data fragment).
 */
export function isRarVolume(ext: string): boolean {
  return RAR_VOLUME_RE.test(ext);
}

/**
 * Given a .r00–.r99 file path, returns the path to the corresponding
 * .rar file if it exists in the same directory, otherwise null.
 *
 * Multi-volume RAR archives store headers in the .rar file;
 * .r00–.r99 are data-only fragments and cannot be opened alone.
 */
export function resolveRarVolume(firstPath: string): string | null {
  const ext = firstPath.match(RAR_VOLUME_RE)?.[0];
  if (!ext) return null;
  const rarPath = firstPath.slice(0, -ext.length) + ".rar";
  return fs.existsSync(rarPath) ? rarPath : null;
}

/**
 * Validate that a file is a genuine RAR archive by checking the
 * "Rar!" magic header. Throws if not valid.
 */
export function validateRarHeader(filePath: string): void {
  const buf = fs.readFileSync(filePath, { flag: "r" });
  if (buf.toString("ascii", 0, 4) !== "Rar!") {
    throw new Error("Not a valid RAR archive (bad header)");
  }
}
