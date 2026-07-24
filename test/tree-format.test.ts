/**
 * Tree, Format & CJK utility tests — Smart Archive VSCode Extension
 *
 * Tests for: tree builder, format utilities, CJK encoding, RAR utilities.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  buildTree,
  countTreeStats,
  fixArchiveEncoding,
  getFullExt,
  formatCompactSize,
  formatDuration,
  isRarExt,
  isRarVolume,
  run7z,
  trackedJS7z,
  resetActiveInstances,
  disposeAllTracked,
} from "./shared-setup";
import type { FlatEntry } from "./shared-setup";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  resetActiveInstances();
});

afterEach(() => {
  disposeAllTracked();
});

const _td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
describe("tree builder", () => {
  it("flat files only", () => {
    const entries: FlatEntry[] = [
      { path: "a.txt", size: 10, type: "REGULAR_FILE" },
      { path: "b.txt", size: 20, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    expect(tree.length).toBe(2);
    const stats = countTreeStats(tree);
    expect(stats.files).toBe(2);
    expect(stats.dirs).toBe(0);
    expect(stats.total).toBe(2);
  });

  it("nested with implicit dirs", () => {
    const entries: FlatEntry[] = [
      { path: "src/main.ts", size: 100, type: "REGULAR_FILE" },
      { path: "src/lib/util.ts", size: 50, type: "REGULAR_FILE" },
      { path: "readme.md", size: 30, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    expect(tree.length).toBe(2);
    const src = tree.find((n) => n.kind === "DIRECTORY");
    expect(src).toBeTruthy();
    expect(src!.children!.length).toBe(2);
    const stats = countTreeStats(tree);
    expect(stats.files).toBe(3);
    expect(stats.dirs).toBe(2);
    expect(stats.total).toBe(5);
  });

  it("explicit directory entries", () => {
    const entries: FlatEntry[] = [
      { path: "dir", size: 0, type: "DIRECTORY" },
      { path: "dir/file.txt", size: 10, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    expect(tree.length).toBe(1);
    expect(tree[0].kind).toBe("DIRECTORY");
    expect(tree[0].children!.length).toBe(1);
    const stats = countTreeStats(tree);
    expect(stats.files).toBe(1);
    expect(stats.dirs).toBe(1);
  });

  it("dedup dir entry with implicit dir", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/package.json", size: 200, type: "REGULAR_FILE" },
      { path: "node_modules/index.js", size: 500, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe("node_modules");
    expect(tree[0].children!.length).toBe(2);
    const stats = countTreeStats(tree);
    expect(stats.dirs).toBe(1);
    expect(stats.files).toBe(2);
  });

  it("archive self-entry filtered", () => {
    const entries: FlatEntry[] = [
      { path: "test.7z", size: 1000, type: "REGULAR_FILE" },
      { path: "data.txt", size: 50, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.7z");
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe("data.txt");
  });
});

// ════════════════════════════════════════════════════════════════════
// Add-to-archive path preservation
// ════════════════════════════════════════════════════════════════════


describe("format utilities", () => {
  it("fixArchiveEncoding passes ASCII through", () => {
    expect(fixArchiveEncoding("hello.txt")).toBe("hello.txt");
    expect(fixArchiveEncoding("")).toBe("");
  });

  it("getFullExt detects wrapped extensions", () => {
    expect(getFullExt("archive.tar.gz")).toBe(".tar.gz");
    expect(getFullExt("archive.tgz")).toBe(".tgz");
    expect(getFullExt("archive.tar.xz")).toBe(".tar.xz");
    expect(getFullExt("archive.7z")).toBe(".7z");
    expect(getFullExt("archive.zip")).toBe(".zip");
  });

  it("formatCompactSize", () => {
    expect(formatCompactSize(0)).toBe("0 B");
    expect(formatCompactSize(500)).toBe("500 B");
    expect(formatCompactSize(1024)).toMatch(/^1\.0 KB/);
    expect(formatCompactSize(1048576)).toMatch(/^1\.0 MB/);
  });

  it("formatDuration", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });
});

// ════════════════════════════════════════════════════════════════════
// RAR utilities
// ════════════════════════════════════════════════════════════════════


describe("CJK encoding", () => {
  it("virtual FS preserves Chinese filenames", async () => {
    const j = await trackedJS7z();
    j.FS.mkdir("/in");
    const cjkName = "中文文件.txt";
    j.FS.writeFile("/in/" + cjkName, new Uint8Array(Buffer.from("hello")));
    const entries = j.FS.readdir("/in");
    const found = entries.filter((e) => e !== "." && e !== "..");
    expect(found.length).toBe(1);
    expect(found[0]).toBe(cjkName);
  });

  it("archive round-trip via FS basename", async () => {
    const j = await trackedJS7z();
    j.FS.mkdir("/in");
    const cjkName = "中文文件.txt";
    j.FS.writeFile("/in/" + cjkName, new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/cjk.7z", "/in/" + cjkName]);
    const j2 = await trackedJS7z();
    const buf = Buffer.from(j.FS.readFile("/cjk.7z", { encoding: "binary" }));
    j2.FS.writeFile("/cjk.7z", new Uint8Array(buf));
    await run7z(j2, ["l", "-slt", "/cjk.7z"]);
    expect(true).toBe(true); // no throw = success
  });
});

// ════════════════════════════════════════════════════════════════════
// Encryption detection
// ════════════════════════════════════════════════════════════════════


describe("RAR utilities", () => {
  it("isRarExt", () => {
    expect(isRarExt(".rar")).toBe(true);
    expect(isRarExt(".r00")).toBe(true);
    expect(isRarExt(".r99")).toBe(true);
    expect(isRarExt(".zip")).toBe(false);
    expect(isRarExt(".7z")).toBe(false);
  });

  it("isRarVolume only matches headerless parts", () => {
    expect(isRarVolume(".r00")).toBe(true);
    expect(isRarVolume(".r50")).toBe(true);
    expect(isRarVolume(".rar")).toBe(false);
    expect(isRarVolume(".r1")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Wrapped format round-trips
// ════════════════════════════════════════════════════════════════════

