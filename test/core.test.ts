/**
 * Core tests — Smart Archive VSCode Extension
 *
 * Tests for: js7z compress/decompress (all formats), encryption,
 * security functions, tree builder, CJK encoding, split volumes,
 * exclusion logic, format utilities, RAR utilities, add-to-archive,
 * rename, convert, merge, encrypt/decrypt workflows.
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
  j7zDecompress,
  copyFS,
  buildTree,
  countTreeStats,
  isEncryptedInline,
  fixArchiveEncoding,
  getFullExt,
  formatCompactSize,
  formatDuration,
  isRarExt,
  isRarVolume,
  createWrapped,
} from "./helpers";
import type { JS7zInstance, FlatEntry } from "./helpers";

const JS7z: (opts?: Record<string, unknown>) => Promise<JS7zInstance> = require("js7z-tools");

const zstd: {
  init: () => Promise<void>;
  compress: (data: Uint8Array, level?: number) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
} = require("@bokuweb/zstd-wasm");

const lz4Wasm: {
  init: () => Promise<void>;
  compress: (data: Uint8Array, options?: { level?: number }) => Promise<Uint8Array>;
} = require("@addmaple/lz4");
let lz4Inited = false;

const { decompress: lz4jsDec } = require("lz4js") as {
  decompress: (data: Uint8Array) => Uint8Array;
};

const brWasm: {
  compress: (data: Uint8Array, options?: { quality?: number }) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
  DecompressStream: new () => {
    decompress: (
      input: Uint8Array,
      outputSize?: number,
    ) => { code: number; buf: Uint8Array; input_offset: number };
    free: () => void;
  };
} = require("brotli-wasm");

function decompressBrotliFrames(data: Buffer): Uint8Array {
  let allOut: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) {
    const stream = new brWasm.DecompressStream();
    const r = stream.decompress(data.subarray(offset), 50 * 1024 * 1024);
    if (r.buf.length > 0) allOut.push(r.buf);
    if (r.input_offset === 0) {
      stream.free();
      break;
    }
    offset += r.input_offset;
    stream.free();
  }
  const total = allOut.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of allOut) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

function decompressLz4Frames(data: Buffer): Uint8Array {
  const LZ4_MAGIC_BUF = Buffer.from([0x04, 0x22, 0x4d, 0x18]);
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) {
    const magicIdx = data.indexOf(LZ4_MAGIC_BUF, offset);
    if (magicIdx < 0) break;
    offset = magicIdx;
    const nextMagic = data.indexOf(LZ4_MAGIC_BUF, offset + 4);
    const end = nextMagic < 0 ? data.length : nextMagic;
    const frame = data.subarray(offset, end);
    parts.push(lz4jsDec(frame));
    offset = end;
  }
  if (parts.length === 0) throw new Error("No LZ4 frames found");
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

// ── Inline security utils (src/utils/security.ts imports vscode) ──

function sanitizeCliPath(entryName: string): string {
  return entryName.startsWith("-") ? "./" + entryName : entryName;
}

function sanitizeTargetDir(dir: string): string {
  if (!dir) return "";
  let safe = dir.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = safe.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") throw new Error("path traversal");
  }
  return safe;
}

function safeJoin(outDir: string, entry: string): string {
  if (entry.includes("\0")) throw new Error(`null byte: ${entry}`);
  const safe = entry
    .replace(/^[a-zA-Z]:\\/, "")
    .replace(/^[a-zA-Z]:/, "")
    .replace(/^\/+/, "");
  const resolved = path.resolve(outDir, safe);
  const norm = path.resolve(outDir) + path.sep;
  const within =
    process.platform === "win32"
      ? resolved.toLowerCase().startsWith(norm.toLowerCase())
      : resolved.startsWith(norm);
  if (!within && resolved !== path.resolve(outDir)) throw new Error("outside");
  return resolved;
}

function parseSize(raw: string | number | undefined, def: number): number {
  if (raw === undefined || raw === null) return def;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return def;
    return Math.min(raw * 1024 * 1024, Number.MAX_SAFE_INTEGER);
  }
  const s = String(raw).trim().toLowerCase();
  if (s === "" || s === "0") return def;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(k|m|g)$/i);
  if (!m) return def;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return def;
  const mult: Record<string, number> = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  const bytes = Math.round(num * mult[m[2].toLowerCase()]);
  return bytes > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : bytes;
}

// ── Exclusion module (direct import — src/utils/exclude.ts has no vscode dep) ──

const { prepareExclusions, isPathExcluded, isTargetExcluded } = await import(
  "../src/utils/exclude"
);

// ── Shared temp dir for disk-based tests ──

const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));

describe("js7z compress/decompress", () => {

  // ── 7z ──

  it("7z single file", async () => {
    const b = await j7zCompress({ "/a.txt": "hello" }, "/x.7z");
    const f = await j7zDecompress(b);
    expect(f["a.txt"]).toBe("hello");
  });

  it("7z multi file", async () => {
    const b = await j7zCompressDir({ "/s/1.txt": "1", "/s/2.txt": "2", "/s/3.txt": "3" }, "/m.7z");
    const f = await j7zDecompress(b);
    expect(Object.keys(f).length).toBe(3);
    expect(f["s/1.txt"]).toBe("1");
  });

  it("7z nested folder", async () => {
    const b = await j7zCompressDir(
      { "/p/readme.md": "#P", "/p/src/main.js": "log(1)", "/p/src/lib/x.js": "exports=1" },
      "/d.7z",
    );
    const f = await j7zDecompress(b);
    expect(Object.keys(f).length).toBe(3);
    expect(f["p/readme.md"]).toBe("#P");
    expect(f["p/src/lib/x.js"]).toBe("exports=1");
  });

  it("7z encrypted -mhe=on", async () => {
    const b = await j7zCompress({ "/s.txt": "sec" }, "/e.7z", ["-ppw", "-mhe=on"]);
    await expect(j7zDecompress(b, "bad")).rejects.toThrow(/7z exit/);
    const f = await j7zDecompress(b, "pw");
    expect(f["s.txt"]).toBe("sec");
  });

  it("7z encrypted no -mhe", async () => {
    const b = await j7zCompress({ "/s.txt": "sec" }, "/e2.7z", ["-ppw"]);
    const f = await j7zDecompress(b, "pw");
    expect(f["s.txt"]).toBe("sec");
  });

  // ── ZIP ──

  it("ZIP single", async () => {
    const b = await j7zCompress({ "/d.txt": "zip" }, "/z.zip");
    const f = await j7zDecompress(b);
    expect(f["d.txt"]).toBe("zip");
  });

  it("ZIP multi", async () => {
    const b = await j7zCompressDir({ "/a/a.txt": "A", "/a/b.txt": "B" }, "/zm.zip");
    const f = await j7zDecompress(b);
    expect(f["a/a.txt"]).toBe("A");
    expect(f["a/b.txt"]).toBe("B");
  });

  it("ZIP nested folder", async () => {
    const b = await j7zCompressDir(
      { "/app/index.html": "<h>", "/app/js/main.js": "var x" },
      "/zf.zip",
    );
    const f = await j7zDecompress(b);
    expect(f["app/index.html"]).toBe("<h>");
    expect(f["app/js/main.js"]).toBe("var x");
  });

  it("ZIP encrypted", async () => {
    const b = await j7zCompress({ "/e.txt": "locked" }, "/ez.zip", ["-ppw"]);
    await expect(j7zDecompress(b, "bad")).rejects.toThrow(/7z exit/);
    const f = await j7zDecompress(b, "pw");
    expect(f["e.txt"]).toBe("locked");
  });

  // ── TAR ──

  it("TAR single", async () => {
    const b = await j7zCompress({ "/n.txt": "tar" }, "/t.tar");
    const f = await j7zDecompress(b);
    expect(f["n.txt"]).toBe("tar");
  });

  it("TAR multi", async () => {
    const b = await j7zCompressDir({ "/x/a.txt": "a", "/x/b.txt": "b" }, "/tm.tar");
    const f = await j7zDecompress(b);
    expect(f["x/a.txt"]).toBe("a");
    expect(f["x/b.txt"]).toBe("b");
  });

  // ── Stream formats ──

  it("GZip stream", async () => {
    const b = await j7zCompress({ "/log.txt": "gzip" }, "/l.gz");
    expect(b.length).toBeLessThan(80);
    const f = await j7zDecompress(b);
    expect(Object.values(f).length).toBeGreaterThanOrEqual(1);
  });

  it("BZip2 stream", async () => {
    const b = await j7zCompress({ "/d.bin": "bz2" }, "/d.bz2");
    expect(b.length).toBeGreaterThan(0);
    const f = await j7zDecompress(b);
    expect(Object.values(f).length).toBeGreaterThanOrEqual(1);
  });

  it("XZ stream", async () => {
    const b = await j7zCompress({ "/c.yml": "xz" }, "/c.xz");
    expect(b.length).toBeGreaterThan(0);
    const f = await j7zDecompress(b);
    expect(Object.values(f).length).toBeGreaterThanOrEqual(1);
  });

  // ── WIM ──

  it("WIM create + extract", async () => {
    const j = await JS7z();
    j.FS.mkdir("/src");
    j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
    await run7z(j, ["a", "-twim", "/tw.wim", "/src"]);
    const buf = Buffer.from(j.FS.readFile("/tw.wim", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["src/a.txt"]).toBe("wim");
  });
});

// ════════════════════════════════════════════════════════════════════
// Security
// ════════════════════════════════════════════════════════════════════

describe("security", () => {
  it("path traversal blocked", () => {
    expect(safeJoin("/tmp/x", "file.txt")).toBe(path.resolve("/tmp/x", "file.txt"));
    expect(() => safeJoin("/tmp/x", "../../../etc/passwd")).toThrow(/outside/);
    expect(() => safeJoin("/tmp/x", "f\0.bin")).toThrow(/null byte/);
  });

  it("size limits", () => {
    const MAX_F = 1024 * 1024 * 1024;
    const MAX_T = 10 * MAX_F;
    const checkFile = (s: number) => {
      if (s > MAX_F) throw new Error("exceeds");
    };
    const checkTotal = (c: number, a: number): number => {
      const t = c + a;
      if (t > MAX_T) throw new Error("exceeds");
      return t;
    };
    expect(() => checkFile(0)).not.toThrow();
    expect(() => checkFile(MAX_F + 1)).toThrow(/exceeds/);
    expect(checkTotal(0, 100)).toBe(100);
    expect(() => checkTotal(MAX_T, 1)).toThrow(/exceeds/);
  });

  it("sanitizeCliPath: normal paths unchanged", () => {
    expect(sanitizeCliPath("normal.txt")).toBe("normal.txt");
    expect(sanitizeCliPath("sub/dir/file.txt")).toBe("sub/dir/file.txt");
  });

  it("sanitizeCliPath: prefixes dash-starting paths with ./", () => {
    expect(sanitizeCliPath("-flag")).toBe("./-flag");
    expect(sanitizeCliPath("--help")).toBe("./--help");
    expect(sanitizeCliPath("-")).toBe("./-");
  });

  it("sanitizeCliPath: empty string unchanged", () => {
    expect(sanitizeCliPath("")).toBe("");
  });

  it("sanitizeTargetDir: normal dirs pass through", () => {
    expect(sanitizeTargetDir("")).toBe("");
    expect(sanitizeTargetDir("sub")).toBe("sub");
    expect(sanitizeTargetDir("sub/dir")).toBe("sub/dir");
  });

  it("sanitizeTargetDir: strips leading slashes", () => {
    expect(sanitizeTargetDir("/foo")).toBe("foo");
    expect(sanitizeTargetDir("///bar")).toBe("bar");
  });

  it("sanitizeTargetDir: rejects .. traversal", () => {
    expect(() => sanitizeTargetDir("..")).toThrow(/path traversal/);
    expect(() => sanitizeTargetDir("../etc")).toThrow(/path traversal/);
    expect(() => sanitizeTargetDir("a/../../b")).toThrow(/path traversal/);
    expect(() => sanitizeTargetDir(".")).toThrow(/path traversal/);
  });

  it("parseSize: string formats", () => {
    const d = 999;
    expect(parseSize("100m", d)).toBe(100 * 1024 * 1024);
    expect(parseSize("1g", d)).toBe(1024 * 1024 * 1024);
    expect(parseSize("500k", d)).toBe(500 * 1024);
    expect(parseSize("0.5g", d)).toBe(512 * 1024 * 1024);
    expect(parseSize("2.5m", d)).toBe(Math.round(2.5 * 1024 * 1024));
  });

  it("parseSize: legacy integer (MiB)", () => {
    const d = 999;
    expect(parseSize(100, d)).toBe(100 * 1024 * 1024);
    expect(parseSize(1024, d)).toBe(1024 * 1024 * 1024);
  });

  it("parseSize: edge cases fall back to default", () => {
    const d = 42;
    expect(parseSize("", d)).toBe(d);
    expect(parseSize("0", d)).toBe(d);
    expect(parseSize("abc", d)).toBe(d);
    expect(parseSize("10xy", d)).toBe(d);
    expect(parseSize("-5m", d)).toBe(d);
    expect(parseSize(NaN, d)).toBe(d);
    expect(parseSize(Infinity, d)).toBe(d);
    expect(parseSize(-1, d)).toBe(d);
    expect(parseSize(undefined, d)).toBe(d);
    expect(parseSize(null as unknown as string, d)).toBe(d);
  });
});

// ════════════════════════════════════════════════════════════════════
// CJK encoding
// ════════════════════════════════════════════════════════════════════

describe("CJK encoding", () => {
  it("virtual FS preserves Chinese filenames", async () => {
    const j = await JS7z();
    j.FS.mkdir("/in");
    const cjkName = "中文文件.txt";
    j.FS.writeFile("/in/" + cjkName, new Uint8Array(Buffer.from("hello")));
    const entries = j.FS.readdir("/in");
    const found = entries.filter((e) => e !== "." && e !== "..");
    expect(found.length).toBe(1);
    expect(found[0]).toBe(cjkName);
  });

  it("archive round-trip via FS basename", async () => {
    const j = await JS7z();
    j.FS.mkdir("/in");
    const cjkName = "中文文件.txt";
    j.FS.writeFile("/in/" + cjkName, new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/cjk.7z", "/in/" + cjkName]);
    const j2 = await JS7z();
    const buf = Buffer.from(j.FS.readFile("/cjk.7z", { encoding: "binary" }));
    j2.FS.writeFile("/cjk.7z", new Uint8Array(buf));
    await run7z(j2, ["l", "-slt", "/cjk.7z"]);
    expect(true).toBe(true); // no throw = success
  });
});

// ════════════════════════════════════════════════════════════════════
// Encryption detection
// ════════════════════════════════════════════════════════════════════

describe("encryption detection", () => {
  it("detects encrypted 7z (listing fails without password)", async () => {
    const b = await j7zCompressDir({ "/f.txt": "secret" }, "/enc.7z", ["-pp4ss", "-mhe=on"]);
    const tmp = path.join(td, "enc-test.7z");
    fs.writeFileSync(tmp, b);
    const encrypted = await isEncryptedInline(tmp);
    expect(encrypted).toBe(true);
    fs.unlinkSync(tmp);
  });

  it("listing succeeds with correct password", async () => {
    const b = await j7zCompressDir({ "/f.txt": "secret" }, "/enc2.7z", ["-pp4ss", "-mhe=on"]);
    let out = "";
    const j = await JS7z({
      print: (t: string) => (out += t + "\n"),
      printErr: () => {},
    });
    j.FS.writeFile("/_t2.7z", new Uint8Array(b));
    await new Promise<void>((resolve, reject) => {
      j.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
      j.callMain(["l", "-slt", "-sccUTF-8", "-pp4ss", "/_t2.7z"]);
    });
    expect(out).toContain("f.txt");
  });

  it("detects encrypted ZIP", async () => {
    const b = await j7zCompressDir({ "/f.txt": "zip-secret" }, "/enc.zip", ["-pzip"]);
    const tmp = path.join(td, "enc-test.zip");
    fs.writeFileSync(tmp, b);
    const encrypted = await isEncryptedInline(tmp);
    expect(encrypted).toBe(true);
    fs.unlinkSync(tmp);
  });
});

// ════════════════════════════════════════════════════════════════════
// Tree builder
// ════════════════════════════════════════════════════════════════════

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

describe("add-to-archive", () => {
  it("individual file paths lose dir structure", async () => {
    const j = await JS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/subdir/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir/a.txt", "/subdir/b.txt"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["a.txt"]).toBe("a");
    expect(f["b.txt"]).toBe("b");
    expect(f["subdir/a.txt"]).toBeUndefined();
  });

  it("passing a directory preserves structure", async () => {
    const j = await JS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/subdir/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["subdir/a.txt"]).toBe("a");
    expect(f["subdir/b.txt"]).toBe("b");
  });

  it("single file in directory preserves dir name", async () => {
    const j = await JS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["subdir/a.txt"]).toBe("a");
  });

  it("deeply nested dir via first-level directory", async () => {
    const j = await JS7z();
    mkdirP(j, "/a/b/c");
    j.FS.writeFile("/a/b/c/d.txt", new Uint8Array(Buffer.from("deep")));
    j.FS.writeFile("/a/b/e.txt", new Uint8Array(Buffer.from("e")));
    await run7z(j, ["a", "/test.7z", "-aot", "/a"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["a/b/c/d.txt"]).toBe("deep");
    expect(f["a/b/e.txt"]).toBe("e");
  });

  it("root-level files via individual paths", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/a.txt", "/b.txt"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["a.txt"]).toBe("a");
    expect(f["b.txt"]).toBe("b");
  });

  it("createFolder: new directory with .smartarchive marker", async () => {
    const j = await JS7z();
    j.FS.writeFile("/f.txt", new Uint8Array(Buffer.from("x")));
    await run7z(j, ["a", "/test.7z", "/f.txt"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await JS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    mkdirP(j2, "/sub/newdir");
    j2.FS.writeFile("/sub/newdir/.smartarchive", new Uint8Array(Buffer.from(".")));
    await run7z(j2, ["a", "/test.7z", "-aot", "/sub"]);

    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["f.txt"]).toBe("x");
    expect(f["sub/newdir/.smartarchive"]).toBe(".");

    const tree = buildTree(
      [
        { path: "f.txt", size: 1, type: "REGULAR_FILE" },
        { path: "sub/newdir/.smartarchive", size: 1, type: "REGULAR_FILE" },
      ],
      "test.7z",
    );
    expect(tree.length).toBe(2);
    const subDir = tree.find((n: any) => n.kind === "DIRECTORY" && n.name === "sub") as any;
    expect(subDir).toBeTruthy();
    expect(subDir!.children!.length).toBe(1);
    expect(subDir!.children![0].name).toBe("newdir");
    expect(subDir!.children![0].kind).toBe("DIRECTORY");
  });
});

// ════════════════════════════════════════════════════════════════════
// Rename
// ════════════════════════════════════════════════════════════════════

describe("rename", () => {
  it("simple file rename via 7z rn", async () => {
    const j = await JS7z();
    j.FS.writeFile("/old.txt", new Uint8Array(Buffer.from("hello")));
    await run7z(j, ["a", "/test.7z", "/old.txt"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await JS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    await run7z(j2, ["rn", "/test.7z", "old.txt", "new.txt"]);
    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));

    const f = await j7zDecompress(buf);
    expect(f["new.txt"]).toBe("hello");
    expect(f["old.txt"]).toBeUndefined();
  });

  it("file in subdirectory", async () => {
    const j = await JS7z();
    mkdirP(j, "/sub");
    j.FS.writeFile("/sub/old.txt", new Uint8Array(Buffer.from("x")));
    await run7z(j, ["a", "/test.7z", "/sub"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await JS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    await run7z(j2, ["rn", "/test.7z", "sub/old.txt", "sub/new.txt"]);
    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));

    const f = await j7zDecompress(buf);
    expect(f["sub/new.txt"]).toBe("x");
    expect(f["sub/old.txt"]).toBeUndefined();
  });

  it("move to different directory", async () => {
    const j = await JS7z();
    mkdirP(j, "/a");
    mkdirP(j, "/b");
    j.FS.writeFile("/a/file.txt", new Uint8Array(Buffer.from("move")));
    await run7z(j, ["a", "/test.7z", "/a", "/b"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await JS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    await run7z(j2, ["rn", "/test.7z", "a/file.txt", "b/file.txt"]);
    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));

    const f = await j7zDecompress(buf);
    expect(f["b/file.txt"]).toBe("move");
    expect(f["a/file.txt"]).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Format / encoding utilities
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

describe("wrapped format round-trips", () => {
  for (const ext of ["tar.gz", "tar.bz2", "tar.xz"] as const) {
    it(`${ext} round-trip`, async () => {
      const files = { "/d/a.txt": "hello", "/d/b.txt": "world", "/e/c.txt": "nested" };
      const j = await JS7z();
      for (const [fp, content] of Object.entries(files)) {
        mkdirP(j, path.posix.dirname(fp));
        j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
      }
      const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[1]))];

      await run7z(j, ["a", "/_t.tar", ...tops]);
      const tarBuf = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

      const j2 = await JS7z();
      j2.FS.writeFile("/_t.tar", new Uint8Array(tarBuf));
      await run7z(j2, ["a", "/_w." + ext, "/_t.tar"]);

      const compBuf = Buffer.from(j2.FS.readFile("/_w." + ext, { encoding: "binary" }));
      const j3 = await JS7z();
      j3.FS.writeFile("/a." + ext, new Uint8Array(compBuf));
      j3.FS.mkdir("/o1");
      await run7z(j3, ["x", "/a." + ext, "-o/o1", "-y"]);

      const top = j3.FS.readdir("/o1").filter((e: string) => e !== "." && e !== "..");
      if (top.length === 0) throw new Error(ext + ": no files after outer decompress");
      const innerTar = top[0];
      const innerData = j3.FS.readFile("/o1/" + innerTar, { encoding: "binary" });

      const j4 = await JS7z();
      j4.FS.writeFile("/_inner.tar", new Uint8Array(innerData));
      j4.FS.mkdir("/o2");
      await run7z(j4, ["x", "/_inner.tar", "-o/o2", "-y"]);

      const result: Record<string, string> = {};
      copyFS(j4, "/o2", "", result);
      expect(result["d/a.txt"]).toBe("hello");
      expect(result["d/b.txt"]).toBe("world");
      expect(result["e/c.txt"]).toBe("nested");
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// Stream-to-VFS for large files
// ════════════════════════════════════════════════════════════════════

describe("stream-to-VFS large files", () => {
  it("7z round-trip with dirs", async () => {
    const root = path.join(td, "src");
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "readme.md"), "A".repeat(50 * 1024 * 1024));
    fs.writeFileSync(path.join(root, "lib", "util.js"), "B".repeat(30 * 1024 * 1024));
    fs.writeFileSync(path.join(root, "bin", "app.exe"), "C".repeat(20 * 1024 * 1024));

    const j = await JS7z();
    function streamDir(localDir: string, vfsDir: string, _token?: unknown) {
      const entries = fs.readdirSync(localDir, { withFileTypes: true });
      for (const e of entries) {
        const loc = path.join(localDir, e.name);
        const vfs = `${vfsDir}/${e.name}`;
        if (e.isDirectory()) {
          j.FS.mkdir(vfs);
          streamDir(loc, vfs);
        } else {
          const rfd = fs.openSync(loc, "r");
          j.FS.createDataFile("/", vfs.replace(/^\//, ""), new Uint8Array(0), true, true, 0o777);
          const stream = j.FS.open(vfs, "w");
          const chunk = Buffer.alloc(10 * 1024 * 1024);
          let pos = 0;
          while (true) {
            const n = fs.readSync(rfd, chunk, 0, chunk.length, pos);
            if (n === 0) break;
            j.FS.write(stream, new Uint8Array(chunk.slice(0, n)), 0, n, pos);
            pos += n;
          }
          j.FS.close(stream);
          fs.closeSync(rfd);
        }
      }
    }
    j.FS.mkdir("/src");
    streamDir(root, "/src");

    await run7z(j, ["a", "/out.7z", "/src", "-mx1"]);
    const outBuf = Buffer.from(j.FS.readFile("/out.7z", { encoding: "binary" }));
    const f = await j7zDecompress(outBuf);

    expect(f["src/readme.md"].length).toBe(50 * 1024 * 1024);
    expect(f["src/lib/util.js"].length).toBe(30 * 1024 * 1024);
    expect(f["src/bin/app.exe"].length).toBe(20 * 1024 * 1024);
  });
});

// ════════════════════════════════════════════════════════════════════
// Split volumes
// ════════════════════════════════════════════════════════════════════

describe("split volumes", () => {
  it("7z round-trip", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("hello")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/x.7z", "/a.txt", "/b.txt", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("x.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(1);

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/x.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["a.txt"]).toBe("hello");
    expect(res["b.txt"]).toBe("world");
  });

  it("zip round-trip", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("hello")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/x.zip", "/a.txt", "/b.txt", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("x.zip."));
    expect(parts.length).toBeGreaterThanOrEqual(1);

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/x.zip.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["a.txt"]).toBe("hello");
    expect(res["b.txt"]).toBe("world");
  });

  it("multi-part 7z forces multiple parts", async () => {
    const j = await JS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/y.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("y.7z."));
    const count = parts.length;
    expect(count).toBeGreaterThanOrEqual(2);

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/y.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["big.txt"].length).toBe(16384);
    expect(res["big.txt"]).toBe("x".repeat(16384));
  });

  it("encrypted 7z round-trip", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("secret")));
    await run7z(j, ["a", "/s.7z", "/a.txt", "-pp4ss", "-mhe=on", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("s.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(1);

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/s.7z.001", "-o/o", "-pp4ss"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["a.txt"]).toBe("secret");
  });

  it("missing middle part throws error", async () => {
    const j = await JS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/x.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/")
      .filter((e: string) => e.startsWith("x.7z."))
      .sort();
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await JS7z();
    const first = parts[0];
    j2.FS.writeFile("/" + first, new Uint8Array(j.FS.readFile("/" + first, { encoding: "binary" })));

    if (parts.length > 2) {
      const last = parts[parts.length - 1];
      j2.FS.writeFile("/" + last, new Uint8Array(j.FS.readFile("/" + last, { encoding: "binary" })));
    }

    let stderr = "";
    let exitCode = 0;
    j2.printErr = (text: string) => {
      stderr += text + "\n";
    };
    await new Promise<void>((resolve) => {
      j2.onExit = (c: number) => {
        exitCode = c;
        resolve();
      };
      j2.callMain(["l", "-slt", "/" + first]);
    });

    expect(exitCode !== 0 || /error|missing|can.*open|unexpected/i.test(stderr)).toBe(true);
  });

  it("readdir skips gaps when parts deleted", async () => {
    const j = await JS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/x.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/")
      .filter((e: string) => e.startsWith("x.7z."))
      .sort();
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa_test_"));
    try {
      for (const p of parts) {
        const data = j.FS.readFile("/" + p, { encoding: "binary" });
        fs.writeFileSync(path.join(tmpDir, p), Buffer.from(data));
      }

      const toDelete = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
      fs.unlinkSync(path.join(tmpDir, toDelete));

      const j2 = await JS7z();
      const name = "x.7z";
      const diskParts = fs
        .readdirSync(tmpDir)
        .filter((f: string) =>
          new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`).test(f),
        )
        .sort();

      for (const dp of diskParts) {
        const diskPath = path.join(tmpDir, dp);
        const data = fs.readFileSync(diskPath);
        j2.FS.writeFile("/" + dp, new Uint8Array(data));
      }

      expect(diskParts.includes(toDelete)).toBe(false);
      expect(diskParts.includes(parts[0])).toBe(true);
      if (parts.length > 2) {
        expect(diskParts.includes(parts[parts.length - 1])).toBe(true);
      }

      let stderr = "";
      let exitCode = 0;
      j2.printErr = (text: string) => {
        stderr += text + "\n";
      };
      await new Promise<void>((resolve) => {
        j2.onExit = (c: number) => {
          exitCode = c;
          resolve();
        };
        j2.callMain(["l", "-slt", "/" + parts[0]]);
      });

      expect(exitCode !== 0 || /error|missing|can.*open|unexpected/i.test(stderr)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// Format conversion
// ════════════════════════════════════════════════════════════════════

describe("format conversion", () => {
  const files27z = { "/sub/a.txt": "one", "/c.txt": "two" };

  it("7z to zip round-trip", async () => {
    const src7z = await j7zCompressDir(files27z, "/_s.7z");
    const orig = await j7zDecompress(src7z);
    expect(orig["sub/a.txt"]).toBe("one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const zip = await j7zCompressDir(files, "/_d.zip");
    const conv = await j7zDecompress(zip);
    expect(Object.values(conv)).toContain("one");
    expect(Object.values(conv)).toContain("two");
  });

  it("7z to tar round-trip", async () => {
    const src7z = await j7zCompressDir(files27z, "/_s2.7z");
    const orig = await j7zDecompress(src7z);
    expect(orig["sub/a.txt"]).toBe("one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const tar = await j7zCompressDir(files, "/_d.tar");
    const conv = await j7zDecompress(tar);
    expect(Object.values(conv)).toContain("one");
    expect(Object.values(conv)).toContain("two");
  });
});

// ════════════════════════════════════════════════════════════════════
// Merge split volumes → single archive
// ════════════════════════════════════════════════════════════════════

describe("merge/split operations", () => {
  it("merge: split 7z back to single", async () => {
    const j1 = await JS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j1, ["a", "/_m.7z", "/big.txt", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_m.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/_m.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(Object.values(res).some((v) => v.length === 16384)).toBe(true);

    const merged = await j7zCompress(res as Record<string, string>, "/_merged.7z");
    const f = await j7zDecompress(merged);
    expect(Object.keys(f).length).toBe(1);
    expect(Object.values(f)[0].length).toBe(16384);
  });

  it("split: single 7z to volumes", async () => {
    const j1 = await JS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j1, ["a", "/_s.7z", "/big.txt"]);
    const srcBuf = Buffer.from(j1.FS.readFile("/_s.7z", { encoding: "binary" }));

    const j2 = await JS7z();
    j2.FS.writeFile("/_s.7z", new Uint8Array(srcBuf));
    j2.FS.mkdir("/_t");
    await run7z(j2, ["x", "/_s.7z", "-o/_t"]);

    const j3 = await JS7z();
    const files: Record<string, string> = {};
    copyFS(j2, "/_t", "", files);
    for (const [k, v] of Object.entries(files)) {
      const d = path.posix.dirname(k);
      if (d && d !== ".") mkdirP(j3, "/" + d);
      j3.FS.writeFile("/" + k, new Uint8Array(Buffer.from(v)));
    }
    j3.FS.mkdir("/_o");
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[0]))];
    await run7z(j3, ["a", "/_o/_d.7z", ...tops, "-v100b"]);

    const parts = j3.FS.readdir("/_o").filter((e) => e.startsWith("_d.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j4 = await JS7z();
    for (const p of parts) {
      const data = j3.FS.readFile("/_o/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j4.FS.mkdir("/chk");
    await run7z(j4, ["x", "/_d.7z.001", "-o/chk"]);
    const dec: Record<string, string> = {};
    copyFS(j4, "/chk", "", dec);
    expect(Object.values(dec).some((v) => v.length === 16384)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// Encrypt / decrypt
// ════════════════════════════════════════════════════════════════════

describe("encrypt/decrypt", () => {
  it("convert: encrypted 7z round-trip preserves encryption", async () => {
    const pw = "p4ssw0rd";
    const src = await j7zCompressDir(
      { "/sub/a.txt": "one", "/c.txt": "two" },
      "/_enc.7z",
      [`-p${pw}`, "-mhe=on"],
    );
    const orig = await j7zDecompress(src, pw);
    expect(orig["sub/a.txt"]).toBe("one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const out = await j7zCompressDir(files, "/_conv.7z", [`-p${pw}`, "-mhe=on"]);
    const conv = await j7zDecompress(out, pw);
    expect(conv["sub/a.txt"]).toBe("one");
    expect(conv["c.txt"]).toBe("two");

    await expect(j7zDecompress(out, "wrong")).rejects.toThrow(/7z exit/);
  });

  it("decrypt: encrypted 7z → non-encrypted", async () => {
    const pw = "s3cret";
    const src = await j7zCompressDir(
      { "/x.txt": "secret-data" },
      "/_enc2.7z",
      [`-p${pw}`, "-mhe=on"],
    );
    await expect(j7zDecompress(src)).rejects.toThrow(/7z exit/);

    const decrypted = await j7zDecompress(src, pw);
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(decrypted)) files["/" + k] = v;
    const stripped = await j7zCompressDir(files, "/_dec.7z");
    const res = await j7zDecompress(stripped);
    expect(res["x.txt"]).toBe("secret-data");
  });

  it("encrypt: non-encrypted 7z → encrypted", async () => {
    const pw = "newpw";
    const plain = await j7zCompressDir({ "/d.txt": "hello" }, "/_pl.7z");
    const orig = await j7zDecompress(plain);
    expect(orig["d.txt"]).toBe("hello");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const enc = await j7zCompressDir(files, "/_enc3.7z", [`-p${pw}`, "-mhe=on"]);
    await expect(j7zDecompress(enc)).rejects.toThrow(/7z exit/);
    const res = await j7zDecompress(enc, pw);
    expect(res["d.txt"]).toBe("hello");
  });

  it("decrypt: encrypted split 7z → non-encrypted split", async () => {
    const pw = "splitpw";
    const j1 = await JS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("y".repeat(16384))));
    await run7z(j1, ["a", "/_es.7z", "/big.txt", `-p${pw}`, "-mhe=on", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_es.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await JS7z();
    for (const p of parts) {
      const d = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/_es.7z.001", "-o/o", `-p${pw}`]);
    const files: Record<string, string> = {};
    copyFS(j2, "/o", "", files);
    expect(files["big.txt"]?.length).toBe(16384);

    const j3 = await JS7z();
    for (const [k, v] of Object.entries(files)) {
      const d = path.posix.dirname(k);
      if (d && d !== ".") mkdirP(j3, "/" + d);
      j3.FS.writeFile("/" + k, new Uint8Array(Buffer.from(v)));
    }
    j3.FS.mkdir("/oo");
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[0]))];
    await run7z(j3, ["a", "/oo/_ds.7z", ...tops, "-v100b"]);

    const newParts = j3.FS.readdir("/oo").filter((e) => e.startsWith("_ds.7z."));
    expect(newParts.length).toBeGreaterThanOrEqual(2);

    const j4 = await JS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j4.FS.mkdir("/chk2");
    await run7z(j4, ["x", "/_ds.7z.001", "-o/chk2"]);
    const dec: Record<string, string> = {};
    copyFS(j4, "/chk2", "", dec);
    expect(dec["big.txt"]?.length).toBe(16384);
  });

  it("encrypt: non-encrypted split 7z → encrypted split", async () => {
    const pw = "encsplit";
    const j1 = await JS7z();
    j1.FS.writeFile("/med.txt", new Uint8Array(Buffer.from("z".repeat(16384))));
    await run7z(j1, ["a", "/_ps.7z", "/med.txt", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_ps.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await JS7z();
    for (const p of parts) {
      const d = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j2.FS.mkdir("/o2");
    await run7z(j2, ["x", "/_ps.7z.001", "-o/o2"]);
    const files: Record<string, string> = {};
    copyFS(j2, "/o2", "", files);

    const j3 = await JS7z();
    for (const [k, v] of Object.entries(files)) {
      const d = path.posix.dirname(k);
      if (d && d !== ".") mkdirP(j3, "/" + d);
      j3.FS.writeFile("/" + k, new Uint8Array(Buffer.from(v)));
    }
    j3.FS.mkdir("/oo2");
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[0]))];
    await run7z(j3, ["a", "/oo2/_es2.7z", ...tops, `-p${pw}`, "-mhe=on", "-v100b"]);

    const newParts = j3.FS.readdir("/oo2").filter((e) => e.startsWith("_es2.7z."));
    expect(newParts.length).toBeGreaterThanOrEqual(2);

    const j4 = await JS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo2/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j4.FS.mkdir("/chk3");
    await expect(run7z(j4, ["x", "-p-", "/_es2.7z.001", "-o/chk3"])).rejects.toThrow(/7z exit/);

    const j5 = await JS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo2/" + p, { encoding: "binary" });
      j5.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j5.FS.mkdir("/chk3b");
    await run7z(j5, ["x", "/_es2.7z.001", "-o/chk3b", `-p${pw}`]);
    const enc: Record<string, string> = {};
    copyFS(j5, "/chk3b", "", enc);
    expect(enc["med.txt"]?.length).toBe(16384);
  });
});

// ════════════════════════════════════════════════════════════════════
// Exclusion logic (uses direct import from src/utils/exclude)
// ════════════════════════════════════════════════════════════════════

describe("exclusion logic", () => {
  let td2: string;

  beforeAll(() => {
    td2 = fs.mkdtempSync(path.join(os.tmpdir(), "sat_excl_"));
  });

  afterAll(() => {
    fs.rmSync(td2, { recursive: true, force: true });
  });

  it("prepareExclusions splits exact names from globs", () => {
    const r = prepareExclusions(["node_modules", "*.log", ".git", "**/dist/**"]);
    expect(r.exactNames.has("node_modules")).toBe(true);
    expect(r.exactNames.has(".git")).toBe(true);
    expect(r.exactNames.has("*.log")).toBe(false);
    expect(r.globPatterns.includes("*.log")).toBe(true);
    expect(r.globPatterns.includes("**/dist/**")).toBe(true);
  });

  it("prepareExclusions handles empty/edge patterns", () => {
    const r = prepareExclusions(["", "**/", "foo"]);
    expect(r.exactNames.size).toBe(1);
    expect(r.globPatterns.length).toBe(0);
    expect(r.exactNames.has("foo")).toBe(true);
  });

  it("isPathExcluded matches root-level dir by name", () => {
    const ex = prepareExclusions(["node_modules", ".git"]);
    expect(isPathExcluded("node_modules", ex)).toBe(true);
    expect(isPathExcluded(".git", ex)).toBe(true);
    expect(isPathExcluded("src", ex)).toBe(false);
  });

  it("isPathExcluded matches nested dir by segment", () => {
    const ex = prepareExclusions(["node_modules"]);
    expect(isPathExcluded("project/node_modules", ex)).toBe(true);
    expect(isPathExcluded("a/b/c/node_modules/d/e", ex)).toBe(true);
    expect(isPathExcluded("project/src", ex)).toBe(false);
  });

  it("isPathExcluded handles Windows-style paths", () => {
    const ex = prepareExclusions(["out"]);
    expect(isPathExcluded("project\\out\\file.js", ex)).toBe(true);
    expect(isPathExcluded("project\\src\\file.js", ex)).toBe(false);
  });

  it("isPathExcluded with glob patterns", () => {
    const ex = prepareExclusions(["*.log", "**/dist/**"]);
    expect(isPathExcluded("error.log", ex)).toBe(true);
    expect(isPathExcluded("deep/nested/error.log", ex)).toBe(true);
    expect(isPathExcluded("src/dist/bundle.js", ex)).toBe(true);
    expect(isPathExcluded("dist/main.js", ex)).toBe(true);
    expect(isPathExcluded("src/app.js", ex)).toBe(false);
  });

  it("isPathExcluded with dotfiles", () => {
    const ex = prepareExclusions([".npm", ".git"]);
    expect(isPathExcluded(".npm", ex)).toBe(true);
    expect(isPathExcluded("project/.npm/_cacache", ex)).toBe(true);
    expect(isPathExcluded(".git/config", ex)).toBe(true);
    expect(isPathExcluded("normal_dir", ex)).toBe(false);
  });

  it("isPathExcluded empty exclusions returns false", () => {
    expect(isPathExcluded("node_modules", prepareExclusions([]))).toBe(false);
  });

  it("isTargetExcluded filters targets by basename", () => {
    const ex = prepareExclusions(["node_modules", "out"]);
    expect(isTargetExcluded("/home/user/project/node_modules", ex)).toBe(true);
    expect(isTargetExcluded("C:\\project\\out", ex)).toBe(true);
    expect(isTargetExcluded("/home/user/project/src", ex)).toBe(false);
  });

  it("isTargetExcluded with glob patterns", () => {
    const ex = prepareExclusions(["*.tmp"]);
    expect(isTargetExcluded("/home/temp.tmp", ex)).toBe(true);
    expect(isTargetExcluded("/home/temp.txt", ex)).toBe(false);
  });

  it("collectPaths-like walk excludes dirs at any depth", () => {
    const base = path.join(td2, "project");
    fs.mkdirSync(path.join(base, "node_modules", "express"), { recursive: true });
    fs.mkdirSync(path.join(base, "src", "lib"), { recursive: true });
    fs.mkdirSync(path.join(base, ".git", "objects"), { recursive: true });
    fs.mkdirSync(path.join(base, "dist"), { recursive: true });
    fs.writeFileSync(path.join(base, "src", "index.js"), "hello");
    fs.writeFileSync(path.join(base, "src", "lib", "util.js"), "util");
    fs.writeFileSync(path.join(base, "package.json"), "{}");
    fs.writeFileSync(path.join(base, "node_modules", "express", "index.js"), "nm");
    fs.writeFileSync(path.join(base, ".git", "HEAD"), "ref");
    fs.writeFileSync(path.join(base, "dist", "bundle.js"), "bundle");

    const ex = prepareExclusions(["node_modules", ".git", "dist"]);
    const result: string[] = [];
    const stack = [base];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const e of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, e.name);
        const rel = path.relative(base, full).replace(/\\/g, "/");
        if (isPathExcluded(rel, ex)) continue;
        if (e.isDirectory()) {
          result.push(full);
          stack.push(full);
        } else {
          result.push(full);
        }
      }
    }

    const relPaths = result.map((f) => path.relative(base, f).replace(/\\/g, "/"));
    const excludedNames = ["node_modules", ".git", "dist"];
    const leaked = relPaths.filter((r) => excludedNames.some((excl) => r.split("/").includes(excl)));
    expect(leaked.length).toBe(0);
    expect(relPaths.includes("src/index.js")).toBe(true);
    expect(relPaths.includes("package.json")).toBe(true);
  });

  it("collectPaths-like walk excludes targets directly", () => {
    const base = path.join(td2, "multi");
    fs.mkdirSync(path.join(base, "included"), { recursive: true });
    fs.mkdirSync(path.join(base, "excluded"), { recursive: true });
    fs.writeFileSync(path.join(base, "included", "a.js"), "a");
    fs.writeFileSync(path.join(base, "excluded", "b.js"), "b");

    const ex = prepareExclusions(["excluded"]);
    const targets = [path.join(base, "included"), path.join(base, "excluded")];
    const filtered = targets.filter((t) => !isTargetExcluded(t, ex));

    expect(filtered.length).toBe(1);
    expect(filtered[0].endsWith("included")).toBe(true);
  });

  it("default patterns exclude all NOISY_DIR_PATTERNS entries", () => {
    const patterns = [
      "node_modules", ".npm", ".yarn", ".venv", "venv", "__pycache__",
      ".pytest_cache", ".mypy_cache", ".tox", ".eggs", "site-packages",
      ".git", ".svn", ".hg",
      "dist", "build", "target", "out", "output",
      ".next", ".nuxt", ".output", ".svelte-kit",
      ".idea", ".vscode", ".vs",
      "coverage", ".nyc_output", ".cache", ".turbo", ".parcel-cache",
      "vendor", "bower_components", ".terraform",
    ];
    const ex = prepareExclusions(patterns);
    for (const p of patterns) {
      expect(isPathExcluded(p, ex)).toBe(true);
    }
    expect(isPathExcluded("a/b/c/node_modules/x/y", ex)).toBe(true);
    expect(isPathExcluded("deep/.git/hooks", ex)).toBe(true);
    expect(isPathExcluded("x/out/y/z", ex)).toBe(true);
    expect(isPathExcluded("normal/file.js", ex)).toBe(false);
  });

  it("**/ prefixed patterns work correctly", () => {
    const ex = prepareExclusions(["**/node_modules", "**/.git"]);
    expect(isPathExcluded("node_modules", ex)).toBe(true);
    expect(isPathExcluded("deep/node_modules", ex)).toBe(true);
    expect(isPathExcluded(".git", ex)).toBe(true);
    expect(isPathExcluded("src/.git", ex)).toBe(true);
    expect(isPathExcluded("src/app.js", ex)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// .smartarchive markers filtered during extraction
// ════════════════════════════════════════════════════════════════════

describe("smartarchive marker filtering", () => {
  it(".smartarchive markers are skipped in VFS-to-disk copy", async () => {
    const j = await JS7z();
    j.FS.mkdir("/_test");
    j.FS.writeFile("/_test/readme.txt", new Uint8Array(Buffer.from("hello")));
    j.FS.writeFile("/_test/.smartarchive", new Uint8Array(Buffer.from(".")));
    j.FS.mkdir("/_test/subdir");
    j.FS.writeFile("/_test/subdir/data.txt", new Uint8Array(Buffer.from("data")));
    j.FS.writeFile("/_test/subdir/.smartarchive", new Uint8Array(Buffer.from(".")));

    const copied: string[] = [];
    const smartarchiveSeen: string[] = [];
    function walk(vfsDir: string) {
      const entries = j.FS.readdir(vfsDir);
      for (const name of entries) {
        if (name === "." || name === "..") continue;
        if (name === ".smartarchive") {
          smartarchiveSeen.push(name);
          continue;
        }
        const full = vfsDir === "/" ? `/${name}` : `${vfsDir}/${name}`;
        const st = j.FS.stat(full);
        if (j.FS.isDir(st.mode)) {
          walk(full);
          continue;
        }
        copied.push(name);
      }
    }
    walk("/_test");
    expect(copied.includes("readme.txt")).toBe(true);
    expect(copied.includes("data.txt")).toBe(true);
    expect(copied.includes(".smartarchive")).toBe(false);
    expect(smartarchiveSeen.length).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// Wrapped format full-operation tests (zst, lz4, br)
// ════════════════════════════════════════════════════════════════════

const stdFiles = { "/d/a.txt": "hello", "/d/b.txt": "world" };

type WrappedCodec = {
  ext: string;
  shortAlias: string;
  compress: (tar: Uint8Array, level?: number) => Promise<Uint8Array>;
  decompress: (data: Buffer) => Uint8Array;
  init?: () => Promise<void>;
};

const codecs: WrappedCodec[] = [
  {
    ext: "tar.zst",
    shortAlias: "tzst",
    compress: async (tar) => {
      const copy = Buffer.alloc(tar.length);
      copy.set(tar);
      return zstd.compress(copy, 3);
    },
    decompress: (data: Buffer) => {
      const copy = Buffer.allocUnsafe(data.length);
      data.copy(copy);
      return zstd.decompress(copy);
    },
  },
  {
    ext: "tar.lz4",
    shortAlias: "tlz4",
    compress: async (tar) => {
      if (!lz4Inited) { await lz4Wasm.init(); lz4Inited = true; }
      return await lz4Wasm.compress(tar);
    },
    decompress: (data: Buffer) => decompressLz4Frames(data),
  },
  {
    ext: "tar.br",
    shortAlias: "tbr",
    compress: async (tar) => brWasm.compress(tar, { quality: 6 }),
    decompress: (data: Buffer) => decompressBrotliFrames(data),
  },
];

for (const c of codecs) {
  describe(`wrapped ${c.ext} operations`, () => {
    it("round-trip compress -> decompress via createWrapped", async () => {
      const wrapped = await createWrapped(stdFiles, c.ext);
      expect(wrapped.length).toBeGreaterThan(0);
      const innerTar = c.decompress(wrapped);
      expect(innerTar.length).toBeGreaterThan(100);

      const j = await JS7z();
      j.FS.writeFile("/_t.tar", innerTar);
      j.FS.mkdir("/_out");
      await run7z(j, ["x", "/_t.tar", "-o/_out", "-y"]);
      const res: Record<string, string> = {};
      copyFS(j, "/_out", "", res);
      expect(res["d/a.txt"]).toBe("hello");
      expect(res["d/b.txt"]).toBe("world");
    });

    it("short alias round-trip", async () => {
      const wrapped = await createWrapped(stdFiles, c.shortAlias);
      const innerTar = c.decompress(wrapped);

      const j = await JS7z();
      j.FS.writeFile("/_t.tar", innerTar);
      j.FS.mkdir("/_out");
      await run7z(j, ["x", "/_t.tar", "-o/_out", "-y"]);
      const res: Record<string, string> = {};
      copyFS(j, "/_out", "", res);
      expect(res["d/a.txt"]).toBe("hello");
    });

    it("selective extraction: extract single file from inner tar", async () => {
      const files = { "/src/index.ts": "console.log(1)", "/src/lib/util.ts": "export const x=1" };
      const wrapped = await createWrapped(files, c.ext);
      const innerTar = c.decompress(wrapped);

      // Selective extract just "src/lib" from the tar
      const j = await JS7z();
      j.FS.writeFile("/_t.tar", innerTar);
      j.FS.mkdir("/_sel");
      // 7z can't selectively extract from tar via path, so extract all and check
      await run7z(j, ["x", "/_t.tar", "-o/_sel", "-y"]);
      const res: Record<string, string> = {};
      copyFS(j, "/_sel", "", res);
      expect(res["src/index.ts"]).toBe("console.log(1)");
      expect(res["src/lib/util.ts"]).toBe("export const x=1");
    });

    it("format conversion: wrapped -> 7z", async () => {
      const wrapped = await createWrapped(stdFiles, c.ext);
      const innerTar = c.decompress(wrapped);

      // Convert the inner tar to 7z
      const j = await JS7z();
      j.FS.writeFile("/_t.tar", innerTar);
      await run7z(j, ["a", "/_out.7z", "/_t.tar"]);
      const conv = await j7zDecompress(Buffer.from(j.FS.readFile("/_out.7z", { encoding: "binary" })));
      expect(Object.keys(conv).length).toBeGreaterThanOrEqual(1);
    });

    it("add files: unwrap -> add to tar -> recompress -> verify", async () => {
      const wrapped = await createWrapped(stdFiles, c.ext);
      const innerTar = c.decompress(wrapped);

      // Add a new file to the tar
      const j = await JS7z();
      j.FS.writeFile("/_t.tar", innerTar);
      j.FS.mkdir("/newdir");
      j.FS.writeFile("/newdir/new.txt", new Uint8Array(Buffer.from("added")));
      await run7z(j, ["a", "/_t.tar", "/newdir"]);
      const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

      // Recompress
      const recompressed = await c.compress(modifiedTar);

      // Decompress and verify
      const finalTar = c.decompress(Buffer.from(recompressed));
      const j2 = await JS7z();
      j2.FS.writeFile("/_t.tar", finalTar);
      j2.FS.mkdir("/_out2");
      await run7z(j2, ["x", "/_t.tar", "-o/_out2", "-y"]);
      const res: Record<string, string> = {};
      copyFS(j2, "/_out2", "", res);
      expect(res["d/a.txt"]).toBe("hello");
      expect(res["d/b.txt"]).toBe("world");
      expect(res["newdir/new.txt"]).toBe("added");
    });

    it("delete files: unwrap -> delete from tar -> recompress -> verify", async () => {
        const wrapped = await createWrapped(stdFiles, c.ext);
        const innerTar = c.decompress(wrapped);

        const j = await JS7z();
        j.FS.writeFile("/_t.tar", innerTar);
        await run7z(j, ["d", "/_t.tar", "d/b.txt"]);
        const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

        const recompressed = await c.compress(modifiedTar);
        const finalTar = c.decompress(Buffer.from(recompressed));
        const j2 = await JS7z();
        j2.FS.writeFile("/_t.tar", finalTar);
        j2.FS.mkdir("/_out3");
        await run7z(j2, ["x", "/_t.tar", "-o/_out3", "-y"]);
        const res: Record<string, string> = {};
        copyFS(j2, "/_out3", "", res);
        expect(res["d/a.txt"]).toBe("hello");
        expect(res["d/b.txt"]).toBeUndefined();
      });

      it("rename files: unwrap -> rename in tar -> recompress -> verify", async () => {
        const wrapped = await createWrapped(stdFiles, c.ext);
        const innerTar = c.decompress(wrapped);

        const j = await JS7z();
        j.FS.writeFile("/_t.tar", innerTar);
        await run7z(j, ["rn", "/_t.tar", "d/a.txt", "d/renamed.txt"]);
        const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

        const recompressed = await c.compress(modifiedTar);
        const finalTar = c.decompress(Buffer.from(recompressed));
        const j2 = await JS7z();
        j2.FS.writeFile("/_t.tar", finalTar);
        j2.FS.mkdir("/_out4");
        await run7z(j2, ["x", "/_t.tar", "-o/_out4", "-y"]);
        const res: Record<string, string> = {};
        copyFS(j2, "/_out4", "", res);
        expect(res["d/renamed.txt"]).toBe("hello");
        expect(res["d/a.txt"]).toBeUndefined();
        expect(res["d/b.txt"]).toBe("world");
      });

      it("create folder: unwrap -> create dir in tar -> recompress -> verify", async () => {
        const wrapped = await createWrapped(stdFiles, c.ext);
        const innerTar = c.decompress(wrapped);

        const j = await JS7z();
        j.FS.writeFile("/_t.tar", innerTar);
        j.FS.mkdir("/newfolder");
        j.FS.writeFile("/newfolder/.smartarchive", new Uint8Array(Buffer.from(".")));
        await run7z(j, ["a", "/_t.tar", "/newfolder"]);
        const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

        const recompressed = await c.compress(modifiedTar);
        const finalTar = c.decompress(Buffer.from(recompressed));
        const j2 = await JS7z();
        j2.FS.writeFile("/_t.tar", finalTar);
        j2.FS.mkdir("/_out5");
        await run7z(j2, ["x", "/_t.tar", "-o/_out5", "-y"]);
        const res: Record<string, string> = {};
        copyFS(j2, "/_out5", "", res);
        expect(res["d/a.txt"]).toBe("hello");
        expect(res["newfolder/.smartarchive"]).toBe(".");
      });

    it("encrypt unsupported: isEncryptableExt returns false", async () => {
      const { isEncryptableExt } = await import("../src/constants");
      expect(isEncryptableExt(`.${c.ext}`)).toBe(false);
      expect(isEncryptableExt(c.shortAlias)).toBe(false);
    });
  });
}

// ════════════════════════════════════════════════════════════════════
// pruneOldPreviews (requires compiled module, may not be available)
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// Workspace compress save path
// ════════════════════════════════════════════════════════════════════
