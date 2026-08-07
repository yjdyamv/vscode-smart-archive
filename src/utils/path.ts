/**
 * Path helpers — 7z VSCode Extension
 *
 * Utilities for constructing virtual file system paths that always
 * use Unix-style forward slashes, regardless of the host OS.
 *
 * @module utils/path
 */

import * as path from "path";
import * as iconv from "iconv-lite";
import { getFullExt, isSplitVolume, resolveSplitVolume } from "../constants";
import { isRarVolume, resolveRarVolume } from "./rar";
import { logger } from "./logger-core";

/**
 * Clean a filename by stripping all trailing compound extensions,
 * then re-appending the format extension.
 *
 * e.g. "report.tar.lz4.tar.lz4" → "report.tar.lz4"
 *
 * @returns The sanitized save name, e.g. "archive.7z"
 */
export function resolveSaveName(raw: string, ext: string): string {
  let clean = raw.trim();
  let prev = "";
  while (prev !== clean) {
    prev = clean;
    const e = getFullExt(clean) || path.extname(clean);
    if (!e) break;
    clean = path.basename(clean, e);
  }
  return `${clean}.${ext}`;
}

/**
 * Resolve the effective archive to operate on when the given path is part
 * of a multi-volume set (RAR .r00–.r99, 7z/zip .001–.999).
 * Returns the original path if not a split volume, or the first
 * volume path if it exists.
 */
export function resolveEffectiveInput(inputPath: string): string {
  const ext = getFullExt(inputPath);

  if (isRarVolume(ext)) {
    const rarPath = resolveRarVolume(inputPath);
    if (rarPath) return rarPath;
  }

  if (isSplitVolume(inputPath) && !isRarVolume(ext)) {
    const resolved = resolveSplitVolume(inputPath);
    if (resolved) return resolved;
  }

  return inputPath;
}

/**
 * Join a virtual FS directory with a file/directory name.
 * Always produces a Unix-style path with forward slashes.
 *
 * @param dir - Virtual FS directory (e.g. '/in')
 * @param name - File or subdirectory name (e.g. 'myfile.txt')
 * @returns Full Unix-style path (e.g. '/in/myfile.txt')
 */
export function joinFSPath(dir: string, name: string): string {
  return `${dir}/${name}`;
}

/**
 * Get the base name of a local file system path.
 *
 * @param fsPath - Native OS path
 * @returns Final path component (file or directory name)
 */
export function getBaseName(fsPath: string): string {
  return path.basename(fsPath);
}

/**
 * Fix garbled CJK filenames from archive listings.
 *
 * Archives may encode entry pathnames using a default charset
 * (CP437 for ZIP without UTF-8 flag, Latin-1 as fallback).
 * When an archive was created on a CJK-locale system (e.g. GBK on
 * Chinese Windows), the pathnames appear as mojibake.
 *
 * Strategy: re-encode the garbled string through the same charset
 * (CP437 → Latin-1 order), then re-decode as GBK
 * via iconv-lite. This recovers the original CJK filenames.
 *
 * @param raw - Potentially garbled pathname from archive listing
 * @returns Corrected pathname
 */
export function fixArchiveEncoding(raw: string): string {
  if (!raw) return raw;

  // Fast path: pure ASCII needs no correction
  // eslint-disable-next-line no-control-regex
  if (/^[ -~]*$/.test(raw)) return raw;

  // Fast path: already valid UTF-8 CJK
  if (!raw.includes("\uFFFD") && /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(raw)) {
    return raw;
  }

  // CP437 is commonly used for ZIP archives without a UTF-8 flag
  // fall back to Latin-1 if CP437 doesn't produce CJK.
  // Try multiple CJK code pages: GBK (Simplified Chinese), Shift-JIS
  // (Japanese), EUC-KR (Korean).
  //
  // Byte-level recovery is fundamentally ambiguous: most CJK byte pairs
  // are valid in more than one code page, and every decode round-trips
  // under iconv. The one exact signal available is full-width kana
  // (U+3040–U+30FF): only Shift-JIS text can decode to kana — GBK and
  // EUC-KR bytes decode to half-width kana at most, never full-width.
  // Hangul-only output is EUC-KR. Everything else (ideograph-only) is
  // ambiguous; the code-page order below encodes the project's primary
  // audience preference (Simplified Chinese first).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceEncodings: any[] = ["cp437", "latin1"];
  const cjkCodePages = ["cp936", "cp932", "cp949"];

  const hasFullWidthKana = (s: string): boolean => /[\u3040-\u30FF]/.test(s);
  const hasHangul = (s: string): boolean => /[\uAC00-\uD7AF]/.test(s);
  const hasIdeograph = (s: string): boolean => /[\u4E00-\u9FFF]/.test(s);

  for (const sourceEnc of sourceEncodings) {
    let bytes: Buffer;
    try {
      bytes = sourceEnc === "cp437" ? iconv.encode(raw, "cp437") : Buffer.from(raw, "latin1");
    } catch {
      logger.warn(
        { event: "fixArchiveEncoding.encode.failed", sourceEnc },
        "Failed to encode string",
      );
      continue;
    }

    let cp936Decoded: string | undefined;
    let cp949Decoded: string | undefined;
    for (const cpName of cjkCodePages) {
      let decoded: string;
      try {
        decoded = iconv.decode(bytes, cpName);
      } catch {
        logger.warn(
          { event: "fixArchiveEncoding.decode.failed", cpName },
          "Failed to decode with code page",
        );
        continue;
      }
      if (decoded.includes("\uFFFD")) continue;
      if (cpName === "cp932" && hasFullWidthKana(decoded)) return decoded;
      if (cpName === "cp936") cp936Decoded = decoded;
      if (cpName === "cp949") cp949Decoded = decoded;
    }

    // Hangul-only output is the EUC-KR signature (ideograph-free).
    if (cp949Decoded !== undefined && hasHangul(cp949Decoded) && !hasIdeograph(cp949Decoded)) {
      return cp949Decoded;
    }
    // Ambiguous ideograph-only case: default to Simplified Chinese.
    if (cp936Decoded !== undefined) return cp936Decoded;
  }

  return raw;
}
