/**
 * package.json ↔ constants.ts sync guard
 *
 * The flat explorer context-menu `when` regexes (Extract, Extract to…,
 * Browse) must stay aligned with DECOMPRESS_EXTENSIONS and with each other,
 * otherwise a readable format silently loses its right-click menu entry.
 * This test fails on drift in either direction.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { DECOMPRESS_EXTENSIONS } from "../src/constants";

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
  contributes: {
    menus: { "explorer/context": { command?: string; when?: string }[] };
  };
};

/** Archive-extension regexes used by the explorer context menu. */
const ARCHIVE_ITEMS = [
  "yjdyamv.smart-archiver.decompress",
  "yjdyamv.smart-archiver.extractTo",
  "yjdyamv.smart-archiver.browse",
] as const;

/** When-regex patterns that are intentional additions over DECOMPRESS_EXTENSIONS. */
const EXTRA_PATTERNS = new Set(["7z.[0-9]+", "zip.[0-9]+", "r\\d{2}", "zst", "lz", "lzma"]);

/** Pull the unescaped alternation out of a `resourceFilename =~ /…/` clause. */
function alternationOf(when: string): Set<string> {
  const m = when.match(/resourceFilename =~ \/\\\.\(([^)]+)\)\$\//);
  expect(m, `cannot parse when clause: ${when}`).toBeTruthy();
  return new Set(m![1].split("|").map((s) => s.replace(/\\\./g, ".")));
}

describe("archive when-regex ↔ DECOMPRESS_EXTENSIONS", () => {
  const items = pkg.contributes.menus["explorer/context"];
  const archiveItems = ARCHIVE_ITEMS.map((id) => items.find((e) => e.command === id));
  const expected = new Set<string>(DECOMPRESS_EXTENSIONS.map((e) => e.slice(1)));

  it("every archive item has the same when regex", () => {
    for (const item of archiveItems) expect(item, "missing archive menu item").toBeTruthy();
    const alternations = archiveItems.map((item) => alternationOf(item!.when!));
    for (let i = 1; i < alternations.length; i++) {
      expect(alternations[i], "archive when regexes drifted apart").toEqual(alternations[0]);
    }
  });

  it("the when regex covers every decompressable extension", () => {
    const actual = alternationOf(archiveItems[0]!.when!);
    for (const ext of expected) {
      expect(actual.has(ext), `missing "${ext}" in the archive menu when`).toBe(true);
    }
  });

  it("the when regex lists no unknown patterns", () => {
    const actual = alternationOf(archiveItems[0]!.when!);
    for (const pattern of actual) {
      expect(
        expected.has(pattern) || EXTRA_PATTERNS.has(pattern),
        `unexpected pattern "${pattern}" in the archive menu when`,
      ).toBe(true);
    }
  });

  it("Compress stays visible on every resource", () => {
    const compress = items.find((e) => e.command === "yjdyamv.smart-archiver.compress");
    expect(compress).toBeTruthy();
    expect(compress!.when).toBeUndefined();
  });
});
