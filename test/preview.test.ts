/**
 * Preview tests — Smart Archive VSCode Extension
 *
 * Tests for: selective extraction (all formats), parse7zListing,
 * markNoisyDirs, two-step wrapped format extraction, zstd round-trip.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import {
  mkdirP,
  run7z,
  j7zCompress,
  j7zCompressDir,
  j7zSelective,
  createWrapped,
  walkFS,
} from "./helpers";
import type { JS7zInstance, TreeNode, FlatEntry } from "./helpers";
import { markNoisyDirs } from "../src/utils/noisy-patterns";

const JS7z: (opts?: Record<string, unknown>) => Promise<JS7zInstance> = require("js7z-tools");
const zstd: {
  init: () => Promise<void>;
  compress: (data: Uint8Array, level?: number) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
} = require("@bokuweb/zstd-wasm");
const lz4: {
  init: () => Promise<void>;
  compress: (data: Uint8Array, options?: { level?: number }) => Promise<Uint8Array>;
  decompress: (data: Uint8Array) => Promise<Uint8Array>;
} = require("@addmaple/lz4");


// ── Format matrix (mirrors FORMAT_TABLE from constants.ts) ──

interface Fmt {
  ext: string;
  wraps: boolean;
  j7z: boolean;
  short: string[];
}

const FM: Fmt[] = [
  { ext: "7z", wraps: false, j7z: true, short: [] },
  { ext: "zip", wraps: false, j7z: true, short: [] },
  { ext: "tar", wraps: false, j7z: true, short: [] },
  { ext: "tar.gz", wraps: true, j7z: false, short: ["tgz"] },
  { ext: "tar.bz2", wraps: true, j7z: false, short: ["tbz2", "tbz"] },
  { ext: "tar.xz", wraps: true, j7z: false, short: ["txz"] },
  { ext: "tar.zst", wraps: true, j7z: false, short: ["tzst"] },
  { ext: "tar.lz", wraps: true, j7z: false, short: ["tlz"] },
  { ext: "tar.lzma", wraps: true, j7z: false, short: [] },
  { ext: "tar.lz4", wraps: true, j7z: false, short: ["tlz4"] },
  { ext: "gz", wraps: false, j7z: true, short: [] },
  { ext: "bz2", wraps: false, j7z: true, short: [] },
  { ext: "xz", wraps: false, j7z: true, short: [] },
];

const stdFiles = { "/d/a.txt": "a", "/d/b.txt": "b", "/e/c.txt": "c" };
const files10: Record<string, string> = {};
for (let i = 1; i <= 10; i++) files10[`/many/${i}.txt`] = `file-${i}`;

let td: string;

describe("selective extraction", () => {
  beforeAll(() => {
    td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
  });

  afterAll(() => {
    fs.rmSync(td, { recursive: true, force: true });
  });

  // ── Selective extraction driven by format matrix ──

  for (const f of FM) {
    if (f.wraps) {
      for (const ext of [f.ext, ...f.short]) {
        if (f.j7z) {
          it(`7z selective: .${ext}`, async () => {
            const b = await createWrapped(stdFiles, ext);
            const r = await j7zSelective(b, ["d/a.txt"]);
            expect(r["d/a.txt"]).toBe("a");
            expect(Object.keys(r).filter((k) => !(k in { "d/a.txt": 1 })).length).toBe(0);
          });
        }
      }
    } else if (f.ext === "gz" || f.ext === "bz2" || f.ext === "xz") {
      if (f.j7z) {
        it(`7z selective: .${f.ext}`, async () => {
          const b = await j7zCompress({ "/data.txt": f.ext }, "/t." + f.ext);
          await j7zSelective(b, ["data.txt"]);
        });
      }
    } else {
      if (f.j7z) {
        it(`7z selective: .${f.ext} single`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt"]);
          expect(r["d/a.txt"]).toBe("a");
          expect(Object.keys(r).filter((k) => !(k in { "d/a.txt": 1 })).length).toBe(0);
        });

        it(`7z selective: .${f.ext} multi`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt", "d/b.txt"]);
          expect(r["d/a.txt"]).toBe("a");
          expect(r["d/b.txt"]).toBe("b");
          expect(Object.keys(r).filter((k) => !(k in { "d/a.txt": 1, "d/b.txt": 1 })).length).toBe(0);
        });

        it(`7z selective: .${f.ext} dir`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d"]);
          expect(r["d/a.txt"]).toBe("a");
          expect(r["d/b.txt"]).toBe("b");
          expect(Object.keys(r).length).toBe(2);
        });
      }
    }
  }

  // ── Edge cases ──

  it("7z selective: WIM", async () => {
    const j = await JS7z();
    mkdirP(j, "/src");
    j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
    j.FS.writeFile("/src/b.txt", new Uint8Array(Buffer.from("no")));
    await run7z(j, ["a", "-twim", "/t.wim", "/src"]);
    const buf = Buffer.from(j.FS.readFile("/t.wim", { encoding: "binary" }));
    const r = await j7zSelective(buf, ["src/a.txt"]);
    expect(r["src/a.txt"]).toBe("wim");
    expect(Object.keys(r).length).toBe(1);
  });

  it("7z selective: nonexistent path", async () => {
    const b = await j7zCompressDir({ "/f.txt": "x" }, "/t.7z");
    const r = await j7zSelective(b, ["no.txt"]);
    expect(Object.keys(r).length).toBe(0);
  });

  it("7z selective: 1-of-10", async () => {
    const b = await j7zCompressDir(files10, "/t.7z");
    const r = await j7zSelective(b, ["many/5.txt"]);
    expect(r["many/5.txt"]).toBe("file-5");
    expect(Object.keys(r).length).toBe(1);
  });

  // ── Encrypted selective extraction ──

  const encFiles = { "/f.txt": "enc" };

  it("7z selective: enc 7z correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.7z", ["-pp4ss", "-mhe=on"]);
    const r = await j7zSelective(b, ["f.txt"], "p4ss");
    expect(r["f.txt"]).toBe("enc");
    expect(Object.keys(r).length).toBe(1);
  });

  it("7z selective: enc 7z wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.7z", ["-pp4ss", "-mhe=on"]);
    await expect(j7zSelective(b, ["f.txt"], "wrong")).rejects.toThrow(/7z exit/);
  });

  it("7z selective: enc ZIP correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    const r = await j7zSelective(b, ["f.txt"], "zip");
    expect(r["f.txt"]).toBe("enc");
    expect(Object.keys(r).length).toBe(1);
  });

  it("7z selective: enc ZIP wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    await expect(j7zSelective(b, ["f.txt"], "wrong")).rejects.toThrow(/7z exit/);
  });

  // ── Two-step 7z x for wrapped formats ──

  for (const ext of ["tar.xz", "tar.gz", "tar.bz2", "tgz", "txz"]) {
    it(`7z x-x-ls: .${ext}`, async () => {
      const b = await createWrapped(stdFiles, ext);

      const j1 = await JS7z();
      j1.FS.writeFile("/a." + ext, new Uint8Array(b));
      j1.FS.mkdir("/_ls1");
      await new Promise<void>((resolve, reject) => {
        j1.onExit = (c: number) => {
          if (c === 0) resolve();
          else reject(new Error(`7z x outer: ${c}`));
        };
        j1.callMain(["x", "/a." + ext, "-o/_ls1", "-y"]);
      });

      const top = j1.FS.readdir("/_ls1").filter((e: string) => e !== "." && e !== "..");
      expect(top.some((e: string) => e.endsWith(".tar"))).toBe(true);

      const innerTar = top.find((e: string) => e.endsWith(".tar"))!;
      const innerData = j1.FS.readFile(`/_ls1/${innerTar}`, { encoding: "binary" });

      const j2 = await JS7z();
      j2.FS.writeFile("/_inner.tar", new Uint8Array(innerData));
      j2.FS.mkdir("/_ls2");
      await new Promise<void>((resolve, reject) => {
        j2.onExit = (c: number) => {
          if (c === 0) resolve();
          else reject(new Error(`7z x inner: ${c}`));
        };
        j2.callMain(["x", "/_inner.tar", "-o/_ls2", "-y"]);
      });

      const paths = walkFS(j2, "/_ls2", "");
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.some((p) => p.includes("d/a.txt"))).toBe(true);
    });
  }

  // ── zstd compression roundtrip ──

  it("zstd roundtrip: compress then self-decompress", async () => {
    const b = await createWrapped(stdFiles, "tar.zst");
    expect(b.length).toBeLessThan(4096);

    const dec = zstd.decompress(b);
    expect(dec.length).toBeGreaterThan(100);

    const j = await JS7z();
    j.FS.writeFile("/_t.tar", dec);
    j.FS.mkdir("/_out");
    await new Promise<void>((resolve, reject) => {
      j.onExit = (c: number) => {
        if (c === 0) resolve();
        else reject(new Error(`7z x tar: ${c}`));
      };
      j.callMain(["x", "/_t.tar", "-o/_out", "-y"]);
    });
    const paths = walkFS(j, "/_out", "");
    expect(paths.includes("d/a.txt")).toBe(true);
    expect(paths.includes("d/b.txt")).toBe(true);
  });

  // ── LZ4 compression roundtrip ──

  it("lz4 init and basic compress", async () => {
    await lz4.init();
    const data = new TextEncoder().encode("hello world lz4 test data");
    const compressed = await lz4.compress(data);
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed.length).toBeLessThan(data.length + 64);
    // LZ4 frame magic: 0x04224D18 in little-endian
    expect(compressed[0]).toBe(0x04);
    expect(compressed[1]).toBe(0x22);
    expect(compressed[2]).toBe(0x4d);
    expect(compressed[3]).toBe(0x18);
  });

  it("lz4 roundtrip: tar.lz4 → self-decompress → 7z extract", async () => {
    // Build a minimal tar with incompressible random padding
    // to work around @addmaple/lz4's outLen = len * 10 estimate.
    function tarHeader(name: string, size: number): Buffer {
      const h = Buffer.alloc(512, 0);
      h.write(name, 0, 100, "ascii");
      h.write("000644 ", 100, 8, "ascii");
      h.write("000000 ", 108, 7, "ascii");
      h.write("000000 ", 116, 7, "ascii");
      h.write(size.toString(8).padStart(11, "0"), 124, 12, "ascii");
      h.write("00000000000 ", 136, 12, "ascii");
      h.write("0", 156, 1, "ascii");
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      h.write(sum.toString(8).padStart(6, "0") + " ", 148, 8, "ascii");
      return h;
    }
    function randPad512(buf: Buffer): Buffer {
      const rem = buf.length % 512;
      if (rem === 0) return buf;
      const pad = Buffer.alloc(512 - rem);
      for (let i = 0; i < pad.length; i++) pad[i] = (i * 7 + 13) % 251 + 1;
      return Buffer.concat([buf, pad]);
    }

    const content = Buffer.from("hello from lz4 test\n");
    const entry = Buffer.concat([
      tarHeader("hello.txt", content.length),
      randPad512(content),
    ]);
    const tarBuf = Buffer.concat([entry, Buffer.alloc(1024, 0)]);
    expect(tarBuf.length).toBe(2048);

    // Compress with LZ4 WASM
    const compressed = await lz4.compress(new Uint8Array(tarBuf));
    expect(compressed.length).toBeGreaterThan(0);

    // Decompress with LZ4 WASM to get inner tar
    const dec = await lz4.decompress(compressed);
    expect(dec.length).toBe(tarBuf.length);

    // Extract the tar with 7z to verify contents
    const j = await JS7z();
    j.FS.writeFile("/_t.tar", dec);
    j.FS.mkdir("/_lz4out");
    await new Promise<void>((resolve, reject) => {
      j.onExit = (c: number) => {
        if (c === 0) resolve();
        else reject(new Error(`7z x tar: ${c}`));
      };
      j.callMain(["x", "/_t.tar", "-o/_lz4out", "-y"]);
    });

    const extracted = j.FS.readFile("/_lz4out/hello.txt", { encoding: "utf8" });
    expect(extracted).toBe("hello from lz4 test\n");
  });
});

// ════════════════════════════════════════════════════════════════════
// parse7zListing
// ════════════════════════════════════════════════════════════════════

function parse7zListing(
  stdout: string,
  archiveName: string,
): { path: string; size: number; type: string }[] {
  const results: { path: string; size: number; type: string }[] = [];
  let curPath = "";
  let curSize = 0;
  let curAttr = "";

  const flush = () => {
    if (curPath) {
      results.push({
        path: curPath,
        size: curSize,
        type: curAttr.includes("D") ? "DIRECTORY" : "REGULAR_FILE",
      });
    }
    curPath = "";
    curSize = 0;
    curAttr = "";
  };

  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\w[\w ]*?)\s*=\s*(.*)/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === "Path") {
      flush();
      curPath = val;
    } else if (key === "Size" && !curSize) {
      curSize = parseInt(val, 10) || 0;
    } else if (key === "Attributes") {
      curAttr = val;
    }
  }
  flush();

  const volBase = archiveName.match(/^(.+\.(?:7z|zip|wim))\.\d+$/i)?.[1] ?? null;
  return results.filter((r) => {
    if (r.path === `/${archiveName}` || r.path === archiveName) return false;
    if (volBase && (r.path === `/${volBase}` || r.path === volBase)) return false;
    return true;
  });
}

function mock7zListing(entries: { path: string; size: number; attr: string }[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`Path = ${e.path}`);
    if (e.size > 0) lines.push(`Size = ${e.size}`);
    if (e.attr) lines.push(`Attributes = ${e.attr}`);
    lines.push("");
  }
  return lines.join("\n");
}

describe("parse7zListing", () => {
  it("basic files and dirs", () => {
    const stdout = mock7zListing([
      { path: "/test.7z", size: 100, attr: "A" },
      { path: "src", size: 0, attr: "D" },
      { path: "src/index.js", size: 42, attr: "A" },
      { path: "src/lib", size: 0, attr: "D" },
      { path: "src/lib/util.js", size: 10, attr: "A" },
      { path: "package.json", size: 5, attr: "A" },
    ]);
    const r = parse7zListing(stdout, "test.7z");
    expect(r.length).toBe(5);
    expect(r[0].path).toBe("src");
    expect(r[0].type).toBe("DIRECTORY");
    expect(r[1].path).toBe("src/index.js");
    expect(r[1].type).toBe("REGULAR_FILE");
    expect(r[1].size).toBe(42);
    expect(r[4].path).toBe("package.json");
    expect(r[4].size).toBe(5);
  });

  it("skips archive self-reference", () => {
    const stdout2 = "Path = archive.7z\nSize = 200\nAttributes = A\n\nPath = readme.md\nSize = 30\nAttributes = A\n\n";
    const r = parse7zListing(stdout2, "archive.7z");
    expect(r.length).toBe(1);
    expect(r[0].path).toBe("readme.md");
  });

  it("empty output returns empty", () => {
    expect(parse7zListing("", "x.7z").length).toBe(0);
    expect(parse7zListing("7-Zip ...\n---\n", "x.7z").length).toBe(0);
  });

  it("handles 7z header lines gracefully", () => {
    const stdout =
      "7-Zip (z) 25.01 ...\n\n" +
      "Scanning the drive:\n" +
      "  0M Scan /\n" +
      "Path = dir/file.txt\nSize = 100\nAttributes = A\n\n" +
      "Path = dir\nSize = 0\nAttributes = D\n\n";
    const r = parse7zListing(stdout, "x.7z");
    expect(r.length).toBe(2);
    expect(r[0].path).toBe("dir/file.txt");
    expect(r[0].size).toBe(100);
    expect(r[1].type).toBe("DIRECTORY");
  });

  it("split volume self-reference filtered", () => {
    const stdout = mock7zListing([
      { path: "/x.7z.001", size: 100, attr: "A" },
      { path: "/x.7z", size: 80, attr: "A" },
      { path: "data.txt", size: 20, attr: "A" },
    ]);
    const r = parse7zListing(stdout, "x.7z.001");
    expect(r.length).toBe(1);
    expect(r[0].path).toBe("data.txt");
  });

  it("size only set on first occurrence", () => {
    const stdout =
      "Path = app.js\nSize = 42\n\n" +
      "Modified = 2024-01-01 00:00:00\n\n" +
      "Path = readme.md\nSize = 100\nAttributes = A\n\n";
    const r = parse7zListing(stdout, "a.7z");
    expect(r[0].path).toBe("app.js");
    expect(r[0].size).toBe(42);
    expect(r[1].size).toBe(100);
  });

  it("CJK filenames preserved", () => {
    const stdout = mock7zListing([
      { path: "中文文件.txt", size: 10, attr: "A" },
      { path: "日本語フォルダ", size: 0, attr: "D" },
    ]);
    const r = parse7zListing(stdout, "a.7z");
    expect(r.length).toBe(2);
    expect(r.some((e) => e.path.includes("中文文件"))).toBe(true);
    expect(r.some((e) => e.type === "DIRECTORY")).toBe(true);
  });
});

function buildTreeLocal(entries: FlatEntry[]): TreeNode[] {
  const normed: { entry: FlatEntry; parts: string[] }[] = [];
  for (const e of entries) {
    let p = e.path.replace(/\\/g, "/");
    if (p.startsWith("./")) p = p.slice(2);
    if (!p || p === ".") continue;
    const parts = p.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    normed.push({ entry: e, parts });
  }
  normed.sort((a, b) => {
    const aD = a.entry.type !== "DIRECTORY" ? 1 : 0;
    const bD = b.entry.type !== "DIRECTORY" ? 1 : 0;
    if (aD !== bD) return aD - bD;
    return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
  });
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();
  const siblingMap = new Map<string, number>();
  for (const { entry, parts } of normed) {
    let siblings = root;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const last = i === parts.length - 1;
      const full = prefix ? prefix + "/" + seg : seg;
      if (last) {
        const isDir = entry.type === "DIRECTORY";
        const existing = dirMap.get(full);
        if (existing && existing.kind === "DIRECTORY") {
          existing.size = entry.size || existing.size;
        } else {
          const node: TreeNode = {
            name: seg,
            path: entry.path,
            size: entry.size,
            kind: isDir ? "DIRECTORY" : "REGULAR_FILE",
            children: isDir ? [] : undefined,
          };
          if (!isDir) siblingMap.set(seg, siblings.length);
          siblings.push(node);
          if (isDir) dirMap.set(full, node);
        }
      } else {
        let dir = dirMap.get(full);
        if (!dir) {
          const dup = siblingMap.get(seg);
          if (dup !== undefined && siblings[dup]?.kind !== "DIRECTORY") {
            siblings.splice(dup, 1);
            siblingMap.delete(seg);
          }
          dir = { name: seg, path: full, size: 0, kind: "DIRECTORY", children: [] };
          siblingMap.set(seg, siblings.length);
          siblings.push(dir);
          dirMap.set(full, dir);
        }
        siblings = dir.children!;
        prefix = full;
      }
    }
  }
  return root;
}

describe("markNoisyDirs", () => {
  it("collapses node_modules at root", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/index.js", size: 100, type: "REGULAR_FILE" },
      { path: "src/index.js", size: 42, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeLocal(entries);
    markNoisyDirs(tree, ["node_modules", ".git"]);
    const nm = tree.find((n) => n.name === "node_modules");
    expect(nm).toBeTruthy();
    expect(nm!.collapsed).toBe(true);
    const src = tree.find((n) => n.name === "src");
    expect(src).toBeTruthy();
    expect(src!.collapsed).toBeUndefined();
  });

  it("collapses nested noisy dirs", () => {
    const entries: FlatEntry[] = [
      { path: "project", size: 0, type: "DIRECTORY" },
      { path: "project/src", size: 0, type: "DIRECTORY" },
      { path: "project/src/node_modules", size: 0, type: "DIRECTORY" },
      { path: "project/src/node_modules/lib.js", size: 10, type: "REGULAR_FILE" },
      { path: "project/.git", size: 0, type: "DIRECTORY" },
      { path: "project/.git/HEAD", size: 5, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeLocal(entries);
    markNoisyDirs(tree, ["node_modules", ".git"]);
    const project = tree.find((n) => n.name === "project");
    expect(project!.collapsed).toBeUndefined();
    const git = project!.children!.find((c) => c.name === ".git");
    expect(git!.collapsed).toBe(true);
    const src = project!.children!.find((c) => c.name === "src");
    expect(src).toBeTruthy();
    const nm = src!.children!.find((c) => c.name === "node_modules");
    expect(nm!.collapsed).toBe(true);
  });

  it("children of noisy dir also collapsed", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/lib", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/lib/app.js", size: 50, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeLocal(entries);
    markNoisyDirs(tree, ["node_modules"]);
    const nm = tree[0];
    expect(nm.collapsed).toBe(true);
    const express = nm.children![0];
    expect(express.collapsed).toBe(true);
    const lib = express.children![0];
    expect(lib.collapsed).toBe(true);
  });

  it("empty patterns does nothing", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules/lib.js", size: 10, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeLocal(entries);
    markNoisyDirs(tree, []);
    expect(tree[0].collapsed).toBeUndefined();
  });

  it("glob patterns work", () => {
    const entries: FlatEntry[] = [
      { path: "logs", size: 0, type: "DIRECTORY" },
      { path: "logs/error.log", size: 20, type: "REGULAR_FILE" },
      { path: "logs/info.log", size: 15, type: "REGULAR_FILE" },
      { path: "src/main.ts", size: 30, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeLocal(entries);
    markNoisyDirs(tree, ["*.log"]);
    const logs = tree.find((n) => n.name === "logs");
    expect(logs!.collapsed).toBeUndefined();
  });

  it("dotfile dirs collapsed", () => {
    const entries: FlatEntry[] = [
      { path: ".npm", size: 0, type: "DIRECTORY" },
      { path: ".npm/_cacache", size: 0, type: "DIRECTORY" },
      { path: ".vscode", size: 0, type: "DIRECTORY" },
      { path: ".vscode/settings.json", size: 8, type: "REGULAR_FILE" },
      { path: "src/app.ts", size: 12, type: "REGULAR_FILE" },
    ];
    const tree = buildTreeLocal(entries);
    markNoisyDirs(tree, [".npm", ".vscode"]);
    expect(tree.find((n) => n.name === ".npm")!.collapsed).toBe(true);
    expect(tree.find((n) => n.name === ".vscode")!.collapsed).toBe(true);
    expect(tree.find((n) => n.name === "src")!.collapsed).toBeUndefined();
  });
});
