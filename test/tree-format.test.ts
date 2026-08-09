/**
 * Tree, Format & CJK utility tests — Smart Archive VSCode Extension
 *
 * Tests for: tree builder, format utilities, CJK encoding, RAR utilities.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as iconv from "iconv-lite";
import {
  buildTreeRootOnly,
  getDirChildren,
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
import { parse7zListing } from "../src/utils/parse7z";
import type { FlatEntry } from "./shared-setup";
import { tmpDir } from "./tmp";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  resetActiveInstances();
});

afterEach(() => {
  disposeAllTracked();
});

const _td = tmpDir("sat_");
describe("tree builder", () => {
  it("flat files only", () => {
    const entries: FlatEntry[] = [
      { path: "a.txt", size: 10, type: "REGULAR_FILE" },
      { path: "b.txt", size: 20, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeRootOnly(entries, "test.zip");
    expect(tree.length).toBe(2);
    expect(tree.map((n) => n.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("nested with implicit dirs", () => {
    const entries: FlatEntry[] = [
      { path: "src/main.ts", size: 100, type: "REGULAR_FILE" },
      { path: "src/lib/util.ts", size: 50, type: "REGULAR_FILE" },
      { path: "readme.md", size: 30, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeRootOnly(entries, "test.zip");
    expect(tree.length).toBe(2);
    const src = tree.find((n) => n.kind === "DIRECTORY");
    expect(src).toBeTruthy();
    expect(src!.hasMore).toBe(true);
    // Lazy children: getDirChildren("") materializes the root, then "src".
    const rootChildren = getDirChildren("", entries);
    expect(rootChildren.find((n) => n.name === "src")!.hasMore).toBe(true);
    const srcChildren = getDirChildren("src", entries);
    expect(srcChildren.map((n) => n.name)).toEqual(["lib", "main.ts"]);
  });

  it("explicit directory entries", () => {
    const entries: FlatEntry[] = [
      { path: "dir", size: 0, type: "DIRECTORY" },
      { path: "dir/file.txt", size: 10, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeRootOnly(entries, "test.zip");
    expect(tree.length).toBe(1);
    expect(tree[0].kind).toBe("DIRECTORY");
    expect(tree[0].hasMore).toBe(true);
    expect(getDirChildren("dir", entries).map((n) => n.name)).toEqual(["file.txt"]);
  });

  it("dedup dir entry with implicit dir", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/package.json", size: 200, type: "REGULAR_FILE" },
      { path: "node_modules/index.js", size: 500, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeRootOnly(entries, "test.zip");
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe("node_modules");
    expect(getDirChildren("node_modules", entries).map((n) => n.name)).toEqual([
      "index.js",
      "package.json",
    ]);
  });

  it("archive self-entry filtered", () => {
    const entries: FlatEntry[] = [
      { path: "test.7z", size: 1000, type: "REGULAR_FILE" },
      { path: "data.txt", size: 50, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeRootOnly(entries, "test.7z");
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe("data.txt");
  });

  it("directories carry hasMore when they have children", () => {
    const entries: FlatEntry[] = [
      { path: "src/main.ts", size: 10, type: "REGULAR_FILE" },
      { path: "empty", size: 0, type: "DIRECTORY" },
    ];
    const tree = buildTreeRootOnly(entries, "test.zip");
    const src = tree.find((n) => n.name === "src");
    expect(src!.kind).toBe("DIRECTORY");
    expect(src!.hasMore).toBe(true);
    // Empty directories have no descendants — no expand arrow.
    const empty = tree.find((n) => n.name === "empty");
    expect(empty!.hasMore).toBe(false);
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

  it("fixArchiveEncoding recovers GBK mojibake (production logic)", () => {
    // 7z decodes non-UTF-8 names as CP437; GBK bytes of a Chinese filename
    // re-encoded through cp437 are the real-world mojibake shape. cp949
    // also decodes these bytes (to hanja garbage) — cp936 must win.
    const gbkBytes = iconv.encode("中文文件.txt", "gbk");
    const mojibake = iconv.decode(gbkBytes, "cp437");
    expect(fixArchiveEncoding(mojibake)).toBe("中文文件.txt");
  });

  it("fixArchiveEncoding decodes Shift-JIS names as GBK (ambiguous, documented)", () => {
    // Full-width kana is a real SJIS signal, but recovery is deliberately
    // GBK-only: Japanese/Korean legacy names are byte-indistinguishable
    // from GBK in the overlapping CJK rows, and the GBK interpretation
    // keeps the preview hot path at one decode.
    const sjisBytes = iconv.encode("テスト.txt", "shiftjis");
    const mojibake = iconv.decode(sjisBytes, "cp437");
    expect(fixArchiveEncoding(mojibake)).toBe(iconv.decode(sjisBytes, "gbk"));
  });

  it("fixArchiveEncoding defaults EUC-KR hangul names to GBK (ambiguous, documented)", () => {
    // Hangul-only names are byte-indistinguishable from GBK names in the
    // 0xB0–0xC8 rows (the same bytes decode to hangul or hanzi). The GBK
    // default — the project's primary audience — wins by design: keeping
    // the EUC-KR check would cost every GBK mojibake name an extra decode
    // on the preview hot path.
    const euckrBytes = iconv.encode("실험결과.txt", "euc-kr");
    const mojibake = iconv.decode(euckrBytes, "cp437");
    expect(fixArchiveEncoding(mojibake)).toBe(iconv.decode(euckrBytes, "gbk"));
  });

  it("getFullExt detects wrapped extensions", () => {
    expect(getFullExt("archive.tar.gz")).toBe(".tar.gz");
    expect(getFullExt("archive.tgz")).toBe(".tgz");
    expect(getFullExt("archive.tar.xz")).toBe(".tar.xz");
    expect(getFullExt("archive.7z")).toBe(".7z");
    expect(getFullExt("archive.zip")).toBe(".zip");
  });

  it("getFullExt resolves split volumes to the base extension", () => {
    expect(getFullExt("archive.7z.001")).toBe(".7z");
    expect(getFullExt("archive.zip.002")).toBe(".zip");
    expect(getFullExt("archive.wim.001")).toBe(".wim");
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

  it("archive round-trip preserves CJK filenames and content", async () => {
    const j = await trackedJS7z();
    j.FS.mkdir("/in");
    const cjkName = "中文文件.txt";
    j.FS.writeFile("/in/" + cjkName, new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/cjk.7z", "/in/" + cjkName]);
    const buf = Buffer.from(j.FS.readFile("/cjk.7z", { encoding: "binary" }));

    // Listing parses through production parse7zListing.
    let listing = "";
    const j2 = await trackedJS7z({
      print: (t: string) => (listing += t + "\n"),
      printErr: () => {},
    });
    j2.FS.writeFile("/cjk.7z", new Uint8Array(buf));
    await new Promise<void>((resolve, reject) => {
      j2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
      j2.callMain(["l", "-slt", "/cjk.7z"]);
    });
    const entries = parse7zListing(listing, "cjk.7z");
    expect(entries.some((e) => e.path.includes("中文文件.txt"))).toBe(true);

    // Extraction returns the original content.
    const j3 = await trackedJS7z();
    j3.FS.writeFile("/cjk.7z", new Uint8Array(buf));
    j3.FS.mkdir("/out");
    await run7z(j3, ["x", "/cjk.7z", "-o/out"]);
    const got = Buffer.from(j3.FS.readFile("/out/中文文件.txt", { encoding: "binary" })).toString();
    expect(got).toBe("world");
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
