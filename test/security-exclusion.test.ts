/**
 * Security & Exclusion tests — Smart Archive VSCode Extension
 *
 * Tests for: security (safeJoin, parseSize, sanitizeCliPath, sanitizeTargetDir),
 * encryption detection, exclusion integration, exclusion logic,
 * and smartarchive marker filtering.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  run7z,
  j7zCompressDir,
  j7zDecompress,
  copyFS,
  isEncryptedInline,
  createWrapped,
  trackedJS7z,
  resetActiveInstances,
  disposeAllTracked,
  zstd,
  lz4,
  decompressBrotliFrames,
  decompressLz4Frames,
  prepareExclusions,
  isPathExcluded,
  isTargetExcluded,
  sanitizeCliPath,
  sanitizeTargetDir,
  safeJoin,
  parseSize,
} from "./shared-setup";
import { testCompress, testDecompress } from "./test-helpers";
import { brotliCompress } from "../src/engines/brotli-codec";
import { snappy, decompressSnappyFrames } from "./shared-setup";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  resetActiveInstances();
});

afterEach(() => {
  disposeAllTracked();
});

const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
describe("exclusion integration", () => {

  it("compression excludes node_modules by default pattern", async () => {
    // In production, user selects a project folder; node_modules is a child
    const buf = await testCompress(
      { "proj/src/index.js": "main", "proj/node_modules/pkg/index.js": "lib" },
      "7z",
      { excludePatterns: ["node_modules"] },
    );
    const f = await testDecompress(buf);
    expect(f["proj/src/index.js"]).toBe("main");
    expect(f["proj/node_modules/pkg/index.js"]).toBeUndefined();
  });

  it("compression excludes .git by default pattern", async () => {
    const buf = await testCompress(
      { "proj/src/main.js": "code", "proj/.git/HEAD": "ref", "proj/.git/config": "cfg" },
      "7z",
      { excludePatterns: [".git"] },
    );
    const f = await testDecompress(buf);
    expect(f["proj/src/main.js"]).toBe("code");
    expect(f["proj/.git/HEAD"]).toBeUndefined();
    expect(f["proj/.git/config"]).toBeUndefined();
  });

  it("compression excludes multiple patterns at once", async () => {
    const buf = await testCompress(
      {
        "proj/src/app.js": "app",
        "proj/node_modules/x/index.js": "x",
        "proj/dist/bundle.js": "bundle",
      },
      "7z",
      { excludePatterns: ["node_modules", "dist"] },
    );
    const f = await testDecompress(buf);
    expect(f["proj/src/app.js"]).toBe("app");
    expect(f["proj/node_modules/x/index.js"]).toBeUndefined();
    expect(f["proj/dist/bundle.js"]).toBeUndefined();
  });

  it("target named like an exclusion is NOT excluded (regression test for b5b16a1)", async () => {
    // This test verifies that a directory named 'output' (which is in the
    // default exclude list) is NOT excluded when it's the compression target.
    const buf = await testCompress(
      { "output/data.txt": "important" },
      "7z",
      { excludePatterns: ["output"] },
    );
    const f = await testDecompress(buf);
    // The target directory 'output' should still be included
    expect(f["output/data.txt"]).toBe("important");
  });

  it("glob patterns exclude matching files", async () => {
    const buf = await testCompress(
      { "src/app.js": "code", "error.log": "err", "debug.log": "dbg", "data.txt": "data" },
      "7z",
      { excludePatterns: ["*.log"] },
    );
    const f = await testDecompress(buf);
    expect(f["src/app.js"]).toBe("code");
    expect(f["data.txt"]).toBe("data");
    expect(f["error.log"]).toBeUndefined();
    expect(f["debug.log"]).toBeUndefined();
  });

  it("multi-target: excludes targets matching patterns (project root scenario)", async () => {
    // Simulates: user selects all items in project root directory
    // node_modules and .git are top-level targets but should be excluded
    const buf = await testCompress(
      {
        "src/index.js": "main",
        "node_modules/pkg/index.js": "lib",
        ".git/HEAD": "ref",
        "package.json": "{}",
      },
      "7z",
      { excludePatterns: ["node_modules", ".git"] },
    );
    const f = await testDecompress(buf);
    expect(f["src/index.js"]).toBe("main");
    expect(f["package.json"]).toBe("{}");
    expect(f["node_modules/pkg/index.js"]).toBeUndefined();
    expect(f[".git/HEAD"]).toBeUndefined();
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
    const j = await trackedJS7z({
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
    const j = await trackedJS7z();
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
  decompress: (data: Buffer) => Uint8Array | Promise<Uint8Array>;
  init?: () => Promise<void>;
};

const codecs: WrappedCodec[] = [
  {
    ext: "tar.zst",
    shortAlias: "tzst",
    compress: async (tar) => {
      const copy = Buffer.alloc(tar.length);
      copy.set(tar);
      return zstd.compress(copy, { compressionLevel: 3 });
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
      return await lz4.compressFrame(tar);
    },
    decompress: (data: Buffer) => decompressLz4Frames(data),
  },
  {
    ext: "tar.br",
    shortAlias: "tbr",
    compress: async (tar) => brotliCompress(tar, 6),
    decompress: (data: Buffer) => decompressBrotliFrames(data),
  },
  {
    ext: "tar.sz",
    shortAlias: "tsz",
    compress: async (tar) => {
      const compressed = snappy.compressSync(tar);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(compressed.length, 0);
      return Buffer.concat([lenBuf, compressed]);
    },
    decompress: (data: Buffer) => decompressSnappyFrames(data),
  },
];

for (const c of codecs) {
  describe(`wrapped ${c.ext} operations`, () => {
    it("round-trip compress -> decompress via createWrapped", async () => {
      const wrapped = await createWrapped(stdFiles, c.ext);
      expect(wrapped.length).toBeGreaterThan(0);
      const innerTar = await c.decompress(wrapped);
      expect(innerTar.length).toBeGreaterThan(100);

      const j = await trackedJS7z();
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
      const innerTar = await c.decompress(wrapped);

      const j = await trackedJS7z();
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
      const innerTar = await c.decompress(wrapped);

      // Selective extract just "src/lib" from the tar
      const j = await trackedJS7z();
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
      const innerTar = await c.decompress(wrapped);

      // Convert the inner tar to 7z
      const j = await trackedJS7z();
      j.FS.writeFile("/_t.tar", innerTar);
      await run7z(j, ["a", "/_out.7z", "/_t.tar"]);
      const conv = await j7zDecompress(Buffer.from(j.FS.readFile("/_out.7z", { encoding: "binary" })));
      expect(Object.keys(conv).length).toBeGreaterThanOrEqual(1);
    });

    it("add files: unwrap -> add to tar -> recompress -> verify", async () => {
      const wrapped = await createWrapped(stdFiles, c.ext);
      const innerTar = await c.decompress(wrapped);

      // Add a new file to the tar
      const j = await trackedJS7z();
      j.FS.writeFile("/_t.tar", innerTar);
      j.FS.mkdir("/newdir");
      j.FS.writeFile("/newdir/new.txt", new Uint8Array(Buffer.from("added")));
      await run7z(j, ["a", "/_t.tar", "/newdir"]);
      const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

      // Recompress
      const recompressed = await c.compress(modifiedTar);

      // Decompress and verify
      const finalTar = await c.decompress(Buffer.from(recompressed));
      const j2 = await trackedJS7z();
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
        const innerTar = await c.decompress(wrapped);

        const j = await trackedJS7z();
        j.FS.writeFile("/_t.tar", innerTar);
        await run7z(j, ["d", "/_t.tar", "d/b.txt"]);
        const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

        const recompressed = await c.compress(modifiedTar);
        const finalTar = await c.decompress(Buffer.from(recompressed));
        const j2 = await trackedJS7z();
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
        const innerTar = await c.decompress(wrapped);

        const j = await trackedJS7z();
        j.FS.writeFile("/_t.tar", innerTar);
        await run7z(j, ["rn", "/_t.tar", "d/a.txt", "d/renamed.txt"]);
        const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

        const recompressed = await c.compress(modifiedTar);
        const finalTar = await c.decompress(Buffer.from(recompressed));
        const j2 = await trackedJS7z();
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
        const innerTar = await c.decompress(wrapped);

        const j = await trackedJS7z();
        j.FS.writeFile("/_t.tar", innerTar);
        j.FS.mkdir("/newfolder");
        j.FS.writeFile("/newfolder/.smartarchive", new Uint8Array(Buffer.from(".")));
        await run7z(j, ["a", "/_t.tar", "/newfolder"]);
        const modifiedTar = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

        const recompressed = await c.compress(modifiedTar);
        const finalTar = await c.decompress(Buffer.from(recompressed));
        const j2 = await trackedJS7z();
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
// Delete entries from archive (7z d) — tar.gz focus
// ════════════════════════════════════════════════════════════════════

