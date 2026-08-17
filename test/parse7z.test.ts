/**
 * parse7zListing edge-case tests — Smart Archiver VSCode Extension
 *
 * Tests the production parse7zListing from src/utils/parse7z.ts with
 * focus on the archivePath self-reference filter.
 */

import { describe, it, expect } from "vitest";
import { parse7zListing } from "../src/utils/parse7z";

describe("parse7zListing — archivePath self-reference filter", () => {
  it("filters Windows absolute path self-reference", () => {
    const stdout = [
      "Path = C:\\Users\\test\\archive.zip",
      "Size = 151",
      "Attributes = A",
      "",
      "Path = src/main.ts",
      "Size = 123",
      "Attributes = A",
      "",
    ].join("\n");

    const results = parse7zListing(stdout, "archive.zip", "C:\\Users\\test\\archive.zip");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("src/main.ts");
  });

  it("filters forward-slash archive path", () => {
    const stdout = [
      "Path = C:/Users/test/archive.tar.gz",
      "Size = 200",
      "Attributes = A",
      "",
      "Path = readme.md",
      "Size = 42",
      "Attributes = A",
      "",
    ].join("\n");

    const results = parse7zListing(
      stdout, "archive.tar.gz", "C:\\Users\\test\\archive.tar.gz",
    );
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("readme.md");
  });

  it("filters case-insensitive archive path", () => {
    const stdout = [
      "Path = D:\\other\\path\\archive.7z",
      "Size = 100",
      "Attributes = A",
      "",
      "Path = data.txt",
      "Size = 100",
      "Attributes = A",
      "",
    ].join("\n");

    const results = parse7zListing(
      stdout, "archive.7z", "d:\\other\\path\\archive.7z",
    );
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("data.txt");
  });

  it("filters VFS-style /archive.7z self-reference", () => {
    const stdout = [
      "Path = /archive.7z",
      "Size = 100",
      "Attributes = A",
      "",
      "Path = readme.md",
      "Size = 50",
      "Attributes = A",
      "",
    ].join("\n");

    const results = parse7zListing(stdout, "archive.7z");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("readme.md");
  });

  it("keeps inner file whose base name matches archive name", () => {
    const stdout = [
      "Path = other/dir/archive.7z",
      "Size = 100",
      "Attributes = A",
      "",
      "Path = readme.md",
      "Size = 50",
      "Attributes = A",
      "",
    ].join("\n");

    const results = parse7zListing(stdout, "archive.7z", "/archive.7z");
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.path === "other/dir/archive.7z")).toBe(true);
  });
});

describe("parse7zListing — edge cases", () => {
  it("empty stdout returns empty array", () => {
    expect(parse7zListing("", "x.7z")).toEqual([]);
  });

  it("entries with Path but no Size default to size 0", () => {
    const stdout = "Path = file.txt\n\n";
    const results = parse7zListing(stdout, "a.7z");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("file.txt");
    expect(results[0].size).toBe(0);
  });

  it("entries with Attributes D are marked DIRECTORY", () => {
    const stdout = "Path = mydir\nAttributes = D\n\n";
    const results = parse7zListing(stdout, "a.7z");
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("DIRECTORY");
  });

  it("handles CRLF line endings", () => {
    const stdout = "Path = a.txt\r\nSize = 10\r\n\r\nPath = b.txt\r\nSize = 20\r\n\r\n";
    const results = parse7zListing(stdout, "x.7z");
    expect(results).toHaveLength(2);
  });

  it("skips empty path entries (flush guard)", () => {
    const stdout = "Path = \nSize = 100\n\nPath = valid.txt\nSize = 50\n\n";
    const results = parse7zListing(stdout, "a.7z");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("valid.txt");
  });

  it("infers directories from path prefixes when Attributes are absent (TAR)", () => {
    const stdout = [
      "Path = src",
      "Path = src/main.ts",
      "Path = src/lib/util.ts",
      "Path = readme.md",
    ].join("\n");
    const results = parse7zListing(stdout, "a.tar");
    const byPath = new Map(results.map((r) => [r.path, r]));
    expect(byPath.size).toBe(4);
    expect(byPath.get("src")!.type).toBe("DIRECTORY");
    expect(byPath.get("src/main.ts")!.type).toBe("REGULAR_FILE");
    expect(byPath.get("src/lib/util.ts")!.type).toBe("REGULAR_FILE");
    expect(byPath.get("readme.md")!.type).toBe("REGULAR_FILE");
  });

  it("infers multi-level directory prefixes and keeps explicit dirs", () => {
    const stdout = ["Path = a/b/c.txt", "Path = a/b", "Path = a"].join("\n");
    const results = parse7zListing(stdout, "a.tar");
    const byPath = new Map(results.map((r) => [r.path, r]));
    expect(byPath.get("a")!.type).toBe("DIRECTORY");
    expect(byPath.get("a/b")!.type).toBe("DIRECTORY");
    expect(byPath.get("a/b/c.txt")!.type).toBe("REGULAR_FILE");
  });

  it("parses a 100k-entry listing quickly (directory inference is not O(n²))", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      lines.push(`Path = dir${i % 1000}/file${i}.txt`);
    }
    const start = Date.now();
    const results = parse7zListing(lines.join("\n"), "big.7z");
    const elapsed = Date.now() - start;
    expect(results.length).toBe(100_000);
    // The former per-entry prefix scan took ~54s at this size; the
    // prefix-set rewrite is ~50ms. 5s gives 100x headroom against slow
    // CI machines while still failing on any O(n²) regression.
    expect(elapsed).toBeLessThan(5000);
  });
});
