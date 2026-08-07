/**
 * Encoding recovery tests — fixArchiveEncoding design contract.
 *
 * The design is UTF-8 default + a fast preview path:
 *   1. Names that already look correct (ASCII / valid UTF-8 CJK) are
 *      never touched — the default.
 *   2. Recovery is GBK-only: every garbled name is re-decoded as GBK
 *      (the project's primary audience). Shift-JIS / EUC-KR names are
 *      byte-indistinguishable from GBK in the overlapping CJK rows and
 *      intentionally decode to the GBK interpretation.
 */

import { describe, it, expect } from "vitest";
import * as iconv from "iconv-lite";
import { fixArchiveEncoding } from "../src/utils/path";

/** Simulate a legacy archive listing: bytes in `enc` shown through CP437. */
const mojibake = (name: string, enc: string): string =>
  iconv.decode(iconv.encode(name, enc), "cp437");

describe("fixArchiveEncoding — UTF-8 default", () => {
  it("never touches pure ASCII names", () => {
    for (const n of ["report-2024.pdf", "readme.txt", "a", "-_-", "?????.txt"]) {
      expect(fixArchiveEncoding(n)).toBe(n);
    }
  });

  it("never touches valid UTF-8 CJK names", () => {
    for (const n of ["压缩包测试.txt", "プロジェクト.md", "한국어파일.txt", "中文目录/子文件.md"]) {
      expect(fixArchiveEncoding(n)).toBe(n);
    }
  });

  it("handles empty input", () => {
    expect(fixArchiveEncoding("")).toBe("");
  });

  it("passes through names already destroyed by lossy extraction ('?' substitution)", () => {
    // The wrapped-format extract path replaces undecodable bytes with '?';
    // such names are indistinguishable from legit '?' names — untouched.
    const raw = "?????????.txt";
    expect(fixArchiveEncoding(raw)).toBe(raw);
  });
});

describe("fixArchiveEncoding — GBK recovery", () => {
  it("recovers GBK names", () => {
    const raw = mojibake("压缩包测试文档.txt", "cp936");
    expect(fixArchiveEncoding(raw)).toBe("压缩包测试文档.txt");
  });

  it("recovers GBK names containing directory separators", () => {
    const raw = mojibake("中文目录/子目录/深层文件.md", "cp936");
    expect(fixArchiveEncoding(raw)).toBe("中文目录/子目录/深层文件.md");
  });

  it("decodes Shift-JIS names as GBK (ambiguous, documented)", () => {
    const raw = mojibake("日本語.txt", "cp932");
    const bytes = iconv.encode(raw, "cp437");
    expect(fixArchiveEncoding(raw)).toBe(iconv.decode(bytes, "cp936"));
    expect(fixArchiveEncoding(raw)).not.toBe("日本語.txt");
  });

  it("decodes EUC-KR names as GBK (ambiguous, documented)", () => {
    const raw = mojibake("한국어파일이름.txt", "cp949");
    const bytes = iconv.encode(raw, "cp437");
    expect(fixArchiveEncoding(raw)).toBe(iconv.decode(bytes, "cp936"));
    expect(fixArchiveEncoding(raw)).not.toBe("한국어파일이름.txt");
  });
});
