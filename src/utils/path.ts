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
 * Fix garbled CJK filenames from libarchive-wasm.
 *
 * libarchive decodes archive entry pathnames using a default charset
 * (CP437 for ZIP without UTF-8 flag, Latin-1 as Emscripten fallback).
 * When an archive was created on a CJK-locale system (e.g. GBK on
 * Chinese Windows), the pathnames appear as mojibake.
 *
 * Strategy: re-encode the garbled string through the same charset
 * libarchive used (CP437 → Latin-1 order), then re-decode as GBK
 * via iconv-lite. This recovers the original CJK filenames.
 *
 * @param raw - Potentially garbled pathname from libarchive
 * @returns Corrected pathname
 */
export function fixArchiveEncoding(raw: string): string {
  if (!raw) return raw;

  // Fast path: pure ASCII needs no correction
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(raw)) return raw;

  // Fast path: already valid UTF-8 CJK
  if (!raw.includes("\uFFFD") && /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(raw)) {
    return raw;
  }

  // libarchive uses CP437 for ZIP without UTF-8 flag;
  // fall back to Latin-1 if CP437 doesn't produce CJK.
  // Try multiple CJK code pages: GBK (Simplified Chinese), Shift-JIS
  // (Japanese), EUC-KR (Korean).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceEncodings: any[] = ["cp437", "latin1"];
  const cjkCodePages = [
    { name: "cp936", pattern: /[\u3005\u3040-\u30FF\u4E00-\u9FFF]/ },
    { name: "cp932", pattern: /[\u3040-\u30FF\uFF66-\uFF9F]/ },
    { name: "cp949", pattern: /[\uAC00-\uD7AF]/ },
  ];

  for (const sourceEnc of sourceEncodings) {
    let bytes: Buffer;
    try {
      bytes = sourceEnc === "cp437" ? iconv.encode(raw, "cp437") : Buffer.from(raw, "latin1");
    } catch {
      continue;
    }
    for (const cp of cjkCodePages) {
      try {
        const decoded = iconv.decode(bytes, cp.name);
        if (cp.pattern.test(decoded)) return decoded;
      } catch {
        /* try next code page */
      }
    }
  }

  return raw;
}
