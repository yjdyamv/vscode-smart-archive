/**
 * i18n unit tests — Smart Archiver VSCode Extension
 *
 * Tests for t() placeholder substitution, compressLevels(), and
 * format utility re-exports. Locale detection relies on the
 * vscode mock (env.language = "en").
 */

import { describe, it, expect } from "vitest";
import { t, compressLevels, formatDuration, formatCompactSize } from "../src/i18n";

describe("t()", () => {
  it("returns English string for known keys", () => {
    expect(t("compress.noFiles")).toBe("No files selected.");
    expect(t("compress.progressTitle")).toBe("Compressing...");
    expect(t("decompress.done")).toBe("Decompressed to: ");
  });

  it("returns the key itself for unknown keys", () => {
    expect(t("nonexistent.key")).toBe("nonexistent.key");
    expect(t("")).toBe("");
  });

  it("substitutes a single placeholder {0}", () => {
    expect(t("archive.copied", "3")).toBe("Copied 3 item(s) from archive");
  });

  it("substitutes multiple placeholders {0} {1}", () => {
    const result = t("security.oversizeWarning", "file.bin", "2.0 GB", "1.0 GB");
    expect(result).toContain("file.bin");
    expect(result).toContain("2.0 GB");
    expect(result).toContain("1.0 GB");
  });

  it("handles missing optional args — placeholder remains", () => {
    expect(t("archive.copied")).toBe("Copied {0} item(s) from archive");
  });

  it("extra args are ignored gracefully", () => {
    const result = t("compress.noFiles", "extra");
    expect(result).toBe("No files selected.");
  });
});

describe("compressLevels", () => {
  it("returns 6 level labels in English", () => {
    const levels = compressLevels();
    expect(levels).toHaveLength(6);
    expect(levels[0]).toBe("0 – Store (fastest)");
    expect(levels[1]).toBe("1 – Fastest");
    expect(levels[2]).toBe("3 – Fast");
    expect(levels[3]).toBe("5 – Normal");
    expect(levels[4]).toBe("7 – Maximum");
    expect(levels[5]).toBe("9 – Ultra");
  });
});

describe("format utilities (re-exported from i18n)", () => {
  it("formatDuration handles ms, s, and m+s", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(125000)).toBe("2m 5s");
    expect(formatDuration(3600000)).toBe("60m 0s");
  });

  it("formatCompactSize handles B through TB", () => {
    expect(formatCompactSize(0)).toBe("0 B");
    expect(formatCompactSize(500)).toBe("500 B");
    expect(formatCompactSize(1024)).toMatch(/^1\.0 KB$/);
    expect(formatCompactSize(1048576)).toMatch(/^1\.0 MB$/);
    expect(formatCompactSize(1073741824)).toMatch(/^1\.0 GB$/);
    const tb = 1024 * 1024 * 1024 * 1024;
    expect(formatCompactSize(tb)).toMatch(/^1\.0 TB$/);
  });
});
