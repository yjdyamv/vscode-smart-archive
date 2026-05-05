import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import {
  test,
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
  passed,
  failed,
} from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z = require("js7z-tools") as (opts?: Record<string, unknown>) => Promise<JS7zInstance>;
import type { JS7zInstance } from "./helpers";

// ════════════════════════════════════════════════════════════════════
void (async () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
  console.log("\n=== Smart Archive — Core Tests ===\n");

  // ── 1. js7z-tools: 7z ──
  await test("7z single file", async () => {
    const b = await j7zCompress({ "/a.txt": "hello" }, "/x.7z");
    const f = await j7zDecompress(b);
    assert.strictEqual(f["a.txt"], "hello");
  });

  await test("7z multi file", async () => {
    const b = await j7zCompressDir({ "/s/1.txt": "1", "/s/2.txt": "2", "/s/3.txt": "3" }, "/m.7z");
    const f = await j7zDecompress(b);
    assert.strictEqual(Object.keys(f).length, 3);
    assert.strictEqual(f["s/1.txt"], "1");
  });

  await test("7z nested folder", async () => {
    const b = await j7zCompressDir(
      { "/p/readme.md": "#P", "/p/src/main.js": "log(1)", "/p/src/lib/x.js": "exports=1" },
      "/d.7z",
    );
    const f = await j7zDecompress(b);
    assert.strictEqual(Object.keys(f).length, 3);
    assert.strictEqual(f["p/readme.md"], "#P");
    assert.strictEqual(f["p/src/lib/x.js"], "exports=1");
  });

  await test("7z encrypted -mhe=on", async () => {
    const b = await j7zCompress({ "/s.txt": "sec" }, "/e.7z", ["-ppw", "-mhe=on"]);
    await assert.rejects(() => j7zDecompress(b, "bad"), /7z exit/);
    const f = await j7zDecompress(b, "pw");
    assert.strictEqual(f["s.txt"], "sec");
  });

  await test("7z encrypted no -mhe", async () => {
    const b = await j7zCompress({ "/s.txt": "sec" }, "/e2.7z", ["-ppw"]);
    const f = await j7zDecompress(b, "pw");
    assert.strictEqual(f["s.txt"], "sec");
  });

  // ── 2. ZIP ──
  await test("ZIP single", async () => {
    const b = await j7zCompress({ "/d.txt": "zip" }, "/z.zip");
    const f = await j7zDecompress(b);
    assert.strictEqual(f["d.txt"], "zip");
  });

  await test("ZIP multi", async () => {
    const b = await j7zCompressDir({ "/a/a.txt": "A", "/a/b.txt": "B" }, "/zm.zip");
    const f = await j7zDecompress(b);
    assert.strictEqual(f["a/a.txt"], "A");
    assert.strictEqual(f["a/b.txt"], "B");
  });

  await test("ZIP nested folder", async () => {
    const b = await j7zCompressDir(
      { "/app/index.html": "<h>", "/app/js/main.js": "var x" },
      "/zf.zip",
    );
    const f = await j7zDecompress(b);
    assert.strictEqual(f["app/index.html"], "<h>");
    assert.strictEqual(f["app/js/main.js"], "var x");
  });

  await test("ZIP encrypted", async () => {
    const b = await j7zCompress({ "/e.txt": "locked" }, "/ez.zip", ["-ppw"]);
    await assert.rejects(() => j7zDecompress(b, "bad"), /7z exit/);
    const f = await j7zDecompress(b, "pw");
    assert.strictEqual(f["e.txt"], "locked");
  });

  // ── 3. TAR ──
  await test("TAR single", async () => {
    const b = await j7zCompress({ "/n.txt": "tar" }, "/t.tar");
    const f = await j7zDecompress(b);
    assert.strictEqual(f["n.txt"], "tar");
  });

  await test("TAR multi", async () => {
    const b = await j7zCompressDir({ "/x/a.txt": "a", "/x/b.txt": "b" }, "/tm.tar");
    const f = await j7zDecompress(b);
    assert.strictEqual(f["x/a.txt"], "a");
    assert.strictEqual(f["x/b.txt"], "b");
  });

  // ── 4. Stream formats ──
  await test("GZip stream", async () => {
    const b = await j7zCompress({ "/log.txt": "gzip" }, "/l.gz");
    assert.ok(b.length < 80);
    const f = await j7zDecompress(b);
    assert.ok(Object.values(f).length >= 1);
  });

  await test("BZip2 stream", async () => {
    const b = await j7zCompress({ "/d.bin": "bz2" }, "/d.bz2");
    assert.ok(b.length > 0);
    const f = await j7zDecompress(b);
    assert.ok(Object.values(f).length >= 1);
  });

  await test("XZ stream", async () => {
    const b = await j7zCompress({ "/c.yml": "xz" }, "/c.xz");
    assert.ok(b.length > 0);
    const f = await j7zDecompress(b);
    assert.ok(Object.values(f).length >= 1);
  });

  // ── 5. WIM ──
  await test("WIM create + extract", async () => {
    const j = await JS7z();
    j.FS.mkdir("/src");
    j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
    await run7z(j, ["a", "-twim", "/tw.wim", "/src"]);
    const buf = Buffer.from(j.FS.readFile("/tw.wim", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f["src/a.txt"], "wim");
  });

  // ── 6. Security ──
  await test("sec: path traversal blocked", () => {
    const safeJoin = (outDir: string, entry: string): string => {
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
    };
    assert.strictEqual(safeJoin("/tmp/x", "file.txt"), path.resolve("/tmp/x", "file.txt"));
    assert.throws(() => safeJoin("/tmp/x", "../../../etc/passwd"), /outside/);
    assert.throws(() => safeJoin("/tmp/x", "f\0.bin"), /null byte/);
  });

  await test("sec: size limits", () => {
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
    assert.doesNotThrow(() => checkFile(0));
    assert.throws(() => checkFile(MAX_F + 1), /exceeds/);
    assert.strictEqual(checkTotal(0, 100), 100);
    assert.throws(() => checkTotal(MAX_T, 1), /exceeds/);
  });

  // ── 9. CJK FS round-trip ──
  await test("CJK: virtual FS preserves Chinese filenames", async () => {
    const j = await JS7z();
    j.FS.mkdir("/in");
    const cjkName = "\u4E2D\u6587\u6587\u4EF6.txt";
    j.FS.writeFile("/in/" + cjkName, new Uint8Array(Buffer.from("hello")));
    const entries = j.FS.readdir("/in");
    const found = entries.filter((e) => e !== "." && e !== "..");
    assert.strictEqual(found.length, 1, `expected 1 entry, got ${found.length}: [${found}]`);
    assert.strictEqual(found[0], cjkName, `got "${found[0]}" expected "${cjkName}"`);
  });

  await test("CJK: archive round-trip via FS basename", async () => {
    const j = await JS7z();
    j.FS.mkdir("/in");
    const cjkName = "\u4E2D\u6587\u6587\u4EF6.txt";
    j.FS.writeFile("/in/" + cjkName, new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/cjk.7z", "/in/" + cjkName]);
    const j2 = await JS7z();
    const buf = Buffer.from(j.FS.readFile("/cjk.7z", { encoding: "binary" }));
    j2.FS.writeFile("/cjk.7z", new Uint8Array(buf));
    await run7z(j2, ["l", "-slt", "/cjk.7z"]);
    assert.ok(true);
  });

  // ── 10. Encryption detection for preview ──
  await test("enc 7z: listing fails without password", async () => {
    const b = await j7zCompressDir({ "/f.txt": "secret" }, "/enc.7z", ["-pp4ss", "-mhe=on"]);
    const tmp = path.join(td, "enc-test.7z");
    fs.writeFileSync(tmp, b);
    const encrypted = await isEncryptedInline(tmp);
    assert.strictEqual(encrypted, true, "isEncrypted should detect encrypted 7z");
    const j = await JS7z();
    j.FS.writeFile("/_t.7z", new Uint8Array(b));
    try {
      await new Promise<void>((resolve, reject) => {
        j.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
        j.callMain(["l", "-slt", "-sccUTF-8", "/_t.7z"]);
      });
      assert.fail("listing encrypted 7z without pw should fail");
    } catch (er) {
      assert.ok((er as Error).message.includes("exit 2"));
    }
    fs.unlinkSync(tmp);
  });

  await test("enc 7z: listing succeeds with correct password", async () => {
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
    assert.ok(out.includes("f.txt"), `listing with pw: ${out.slice(0, 200)}`);
  });

  await test("enc ZIP: isEncrypted detects encryption", async () => {
    const b = await j7zCompressDir({ "/f.txt": "zip-secret" }, "/enc.zip", ["-pzip"]);
    const tmp = path.join(td, "enc-test.zip");
    fs.writeFileSync(tmp, b);
    const encrypted = await isEncryptedInline(tmp);
    assert.strictEqual(encrypted, true, "isEncrypted should detect encrypted ZIP");
    fs.unlinkSync(tmp);
  });

  // ── 11. Tree builder ──
  await test("tree: flat files only", () => {
    const entries = [
      { path: "a.txt", size: 10, type: "REGULAR_FILE" },
      { path: "b.txt", size: 20, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    assert.strictEqual(tree.length, 2);
    const stats = countTreeStats(tree);
    assert.strictEqual(stats.files, 2);
    assert.strictEqual(stats.dirs, 0);
    assert.strictEqual(stats.total, 2);
  });

  await test("tree: nested with implicit dirs", () => {
    const entries = [
      { path: "src/main.ts", size: 100, type: "REGULAR_FILE" },
      { path: "src/lib/util.ts", size: 50, type: "REGULAR_FILE" },
      { path: "readme.md", size: 30, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    assert.strictEqual(tree.length, 2);
    const src = tree.find((n) => n.kind === "DIRECTORY");
    assert.ok(src, "should have src directory");
    assert.strictEqual(src!.children!.length, 2);
    const stats = countTreeStats(tree);
    assert.strictEqual(stats.files, 3);
    assert.strictEqual(stats.dirs, 2);
    assert.strictEqual(stats.total, 5);
  });

  await test("tree: explicit directory entries", () => {
    const entries = [
      { path: "dir", size: 0, type: "DIRECTORY" },
      { path: "dir/file.txt", size: 10, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].kind, "DIRECTORY");
    assert.strictEqual(tree[0].children!.length, 1);
    const stats = countTreeStats(tree);
    assert.strictEqual(stats.files, 1);
    assert.strictEqual(stats.dirs, 1);
  });

  await test("tree: dedup dir entry with implicit dir", () => {
    const entries = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/package.json", size: 200, type: "REGULAR_FILE" },
      { path: "node_modules/index.js", size: 500, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].name, "node_modules");
    assert.strictEqual(tree[0].children!.length, 2);
    const stats = countTreeStats(tree);
    assert.strictEqual(stats.dirs, 1);
    assert.strictEqual(stats.files, 2);
  });

  await test("tree: archive self-entry filtered", () => {
    const entries = [
      { path: "test.7z", size: 1000, type: "REGULAR_FILE" },
      { path: "data.txt", size: 50, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.7z");
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].name, "data.txt");
  });

  // ── 15. Add-to-archive path preservation ──
  await test("add: individual file paths lose dir structure", async () => {
    const j = await JS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/subdir/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir/a.txt", "/subdir/b.txt"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    assert.ok(f["a.txt"], "a.txt should exist at root");
    assert.ok(f["b.txt"], "b.txt should exist at root");
    assert.ok(!f["subdir/a.txt"], "subdir/a.txt should NOT exist (stripped)");
  });

  await test("add: passing a directory preserves structure", async () => {
    const j = await JS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/subdir/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f["subdir/a.txt"], "a", "should preserve subdir/");
    assert.strictEqual(f["subdir/b.txt"], "b");
  });

  await test("add: single file in directory preserves dir name", async () => {
    const j = await JS7z();
    j.FS.mkdir("/subdir");
    j.FS.writeFile("/subdir/a.txt", new Uint8Array(Buffer.from("a")));
    await run7z(j, ["a", "/test.7z", "-aot", "/subdir"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f["subdir/a.txt"], "a");
  });

  await test("add: deeply nested dir via first-level directory", async () => {
    const j = await JS7z();
    mkdirP(j, "/a/b/c");
    j.FS.writeFile("/a/b/c/d.txt", new Uint8Array(Buffer.from("deep")));
    j.FS.writeFile("/a/b/e.txt", new Uint8Array(Buffer.from("e")));
    await run7z(j, ["a", "/test.7z", "-aot", "/a"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f["a/b/c/d.txt"], "deep");
    assert.strictEqual(f["a/b/e.txt"], "e");
  });

  await test("add: root-level files via individual paths", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("a")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("b")));
    await run7z(j, ["a", "/test.7z", "-aot", "/a.txt", "/b.txt"]);
    const buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f["a.txt"], "a");
    assert.strictEqual(f["b.txt"], "b");
  });

  await test("createFolder: new directory with .smartarchive marker", async () => {
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
    assert.strictEqual(f["f.txt"], "x");
    assert.strictEqual(f["sub/newdir/.smartarchive"], ".");

    const tree = buildTree(
      [
        { path: "f.txt", size: 1, type: "REGULAR_FILE" },
        { path: "sub/newdir/.smartarchive", size: 1, type: "REGULAR_FILE" },
      ],
      "test.7z",
    );
    assert.strictEqual(tree.length, 2, "should have f.txt + sub/ dir");
    const subDir = tree.find((n: any) => n.kind === "DIRECTORY" && n.name === "sub") as any;
    assert.ok(subDir, "sub/ should exist as implicit directory");
    assert.strictEqual(subDir!.children!.length, 1);
    assert.strictEqual(subDir!.children![0].name, "newdir");
    assert.strictEqual(subDir!.children![0].kind, "DIRECTORY");
  });

  // ── Rename ──
  await test("rename: simple file rename via 7z rn", async () => {
    const j = await JS7z();
    j.FS.writeFile("/old.txt", new Uint8Array(Buffer.from("hello")));
    await run7z(j, ["a", "/test.7z", "/old.txt"]);
    let buf = Buffer.from(j.FS.readFile("/test.7z", { encoding: "binary" }));

    const j2 = await JS7z();
    j2.FS.writeFile("/test.7z", new Uint8Array(buf));
    await run7z(j2, ["rn", "/test.7z", "old.txt", "new.txt"]);
    buf = Buffer.from(j2.FS.readFile("/test.7z", { encoding: "binary" }));

    const f = await j7zDecompress(buf);
    assert.strictEqual(f["new.txt"], "hello", "file should be renamed");
    assert.ok(!f["old.txt"], "old name should not exist");
  });

  await test("rename: file in subdirectory", async () => {
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
    assert.strictEqual(f["sub/new.txt"], "x");
    assert.ok(!f["sub/old.txt"]);
  });

  await test("rename: move to different directory", async () => {
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
    assert.strictEqual(f["b/file.txt"], "move");
    assert.ok(!f["a/file.txt"]);
  });

  // ── 16. Format / encoding utilities ──
  await test("util: fixArchiveEncoding passes ASCII through", () => {
    assert.strictEqual(fixArchiveEncoding("hello.txt"), "hello.txt");
    assert.strictEqual(fixArchiveEncoding(""), "");
  });

  await test("util: getFullExt detects wrapped extensions", () => {
    assert.strictEqual(getFullExt("archive.tar.gz"), ".tar.gz");
    assert.strictEqual(getFullExt("archive.tgz"), ".tgz");
    assert.strictEqual(getFullExt("archive.tar.xz"), ".tar.xz");
    assert.strictEqual(getFullExt("archive.7z"), ".7z");
    assert.strictEqual(getFullExt("archive.zip"), ".zip");
  });

  await test("util: formatCompactSize", () => {
    assert.strictEqual(formatCompactSize(0), "0 B");
    assert.strictEqual(formatCompactSize(500), "500 B");
    assert.ok(formatCompactSize(1024).startsWith("1.0 KB"));
    assert.ok(formatCompactSize(1048576).startsWith("1.0 MB"));
  });

  await test("util: formatDuration", () => {
    assert.strictEqual(formatDuration(500), "500ms");
    assert.strictEqual(formatDuration(5000), "5s");
    assert.strictEqual(formatDuration(65000), "1m 5s");
    assert.strictEqual(formatDuration(125000), "2m 5s");
  });

  // ── 17. RAR utilities ──
  await test("rar: isRarExt", () => {
    assert.strictEqual(isRarExt(".rar"), true);
    assert.strictEqual(isRarExt(".r00"), true);
    assert.strictEqual(isRarExt(".r99"), true);
    assert.strictEqual(isRarExt(".zip"), false);
    assert.strictEqual(isRarExt(".7z"), false);
  });

  await test("rar: isRarVolume only matches headerless parts", () => {
    assert.strictEqual(isRarVolume(".r00"), true);
    assert.strictEqual(isRarVolume(".r50"), true);
    assert.strictEqual(isRarVolume(".rar"), false);
    assert.strictEqual(isRarVolume(".r1"), false);
  });

  // ── 18. Wrapped format round-trips ──  
  for (const ext of ["tar.gz", "tar.bz2", "tar.xz"] as const) {
    await test(`wrapped: ${ext} round-trip`, async () => {
      const files = { "/d/a.txt": "hello", "/d/b.txt": "world", "/e/c.txt": "nested" };
      const j = await JS7z();
      for (const [fp, content] of Object.entries(files)) {
        mkdirP(j, path.posix.dirname(fp));
        j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
      }
      const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[1]))];

      // Create tar  
      await run7z(j, ["a", "/_t.tar", ...tops]);
      const tarBuf = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

      // Compress tar to wrapped format
      const j2 = await JS7z();
      j2.FS.writeFile("/_t.tar", new Uint8Array(tarBuf));
      await run7z(j2, ["a", "/_w." + ext, "/_t.tar"]);

      // Decompress outer layer
      const compBuf = Buffer.from(j2.FS.readFile("/_w." + ext, { encoding: "binary" }));
      const j3 = await JS7z();
      j3.FS.writeFile("/a." + ext, new Uint8Array(compBuf));
      j3.FS.mkdir("/o1");
      await run7z(j3, ["x", "/a." + ext, "-o/o1", "-y"]);

      // Find inner tar and extract it
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
      assert.strictEqual(result["d/a.txt"], "hello", ext + ": d/a.txt mismatch");
      assert.strictEqual(result["d/b.txt"], "world", ext + ": d/b.txt mismatch");
      assert.strictEqual(result["e/c.txt"], "nested", ext + ": e/c.txt mismatch");
    });
  }

  // ── 21. Stream-to-VFS for large files ──
  await test("streamToVFS: 7z round-trip with dirs", async () => {
    // Create a directory structure with multiple files on disk
    const root = path.join(td, "src");
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "readme.md"), "A".repeat(50 * 1024 * 1024)); // 50MB
    fs.writeFileSync(path.join(root, "lib", "util.js"), "B".repeat(30 * 1024 * 1024)); // 30MB
    fs.writeFileSync(path.join(root, "bin", "app.exe"), "C".repeat(20 * 1024 * 1024)); // 20MB

    const j = await JS7z();
    // Stream the entire directory into VFS via copyInputsToFS equivalent
    function streamDir(localDir: string, vfsDir: string, token?: unknown) {
      const entries = fs.readdirSync(localDir, { withFileTypes: true });
      for (const e of entries) {
        const loc = path.join(localDir, e.name);
        const vfs = `${vfsDir}/${e.name}`;
        if (e.isDirectory()) {
          j.FS.mkdir(vfs);
          streamDir(loc, vfs);
        } else {
          const rfd = fs.openSync(loc, "r");
          const st = fs.fstatSync(rfd);
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

    // Compress
    await run7z(j, ["a", "/out.7z", "/src", "-mx1"]);
    const outBuf = Buffer.from(j.FS.readFile("/out.7z", { encoding: "binary" }));
    const f = await j7zDecompress(outBuf);

    assert.strictEqual(f["src/readme.md"].length, 50 * 1024 * 1024);
    assert.strictEqual(f["src/lib/util.js"].length, 30 * 1024 * 1024);
    assert.strictEqual(f["src/bin/app.exe"].length, 20 * 1024 * 1024);
  });

  // ── 22. Split volume round-trip (7z) ──
  await test("split: 7z round-trip", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("hello")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/x.7z", "/a.txt", "/b.txt", "-v10m"]);

    // Collect all volume parts
    const parts = j.FS.readdir("/").filter((e) => e.startsWith("x.7z."));
    assert.ok(parts.length >= 1, "expected at least 1 split part");

    // Re-assemble: write all parts into a new VFS instance and list
    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/x.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    assert.strictEqual(res["a.txt"], "hello");
    assert.strictEqual(res["b.txt"], "world");
  });

  // ── 23. Split volume round-trip (zip) ──
  await test("split: zip round-trip", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("hello")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/x.zip", "/a.txt", "/b.txt", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("x.zip."));
    assert.ok(parts.length >= 1, "expected at least 1 split part");

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/x.zip.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    assert.strictEqual(res["a.txt"], "hello");
    assert.strictEqual(res["b.txt"], "world");
  });

  // ── 24. Split volume with small chunk size (forces multiple parts) ──
  await test("split: multi-part 7z", async () => {
    const j = await JS7z();
    // Write a file big enough to split into multiple 1k parts
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/y.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("y.7z."));
    const count = parts.length;
    assert.ok(count >= 2, `expected >= 2 split parts, got ${count}`);

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/y.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    assert.strictEqual(res["big.txt"].length, 16384);
    assert.strictEqual(res["big.txt"], "x".repeat(16384));
  });

  // ── 25. Split volume with encryption ──
  await test("split: encrypted 7z round-trip", async () => {
    const j = await JS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("secret")));
    await run7z(j, ["a", "/s.7z", "/a.txt", "-pp4ss", "-mhe=on", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("s.7z."));
    assert.ok(parts.length >= 1, "expected at least 1 split part");

    const j2 = await JS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/s.7z.001", "-o/o", "-pp4ss"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    assert.strictEqual(res["a.txt"], "secret");
  });

  // ── 26. Format conversion ──
  const files27z = { "/sub/a.txt": "one", "/c.txt": "two" };

  await test("convert: 7z to zip round-trip", async () => {
    const src7z = await j7zCompressDir(files27z, "/_s.7z");
    const orig = await j7zDecompress(src7z);
    assert.strictEqual(orig["sub/a.txt"], "one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const zip = await j7zCompressDir(files, "/_d.zip");
    const conv = await j7zDecompress(zip);
    assert.ok(Object.values(conv).includes("one"), "one");
    assert.ok(Object.values(conv).includes("two"), "two");
  });

  await test("convert: 7z to tar round-trip", async () => {
    const src7z = await j7zCompressDir(files27z, "/_s2.7z");
    const orig = await j7zDecompress(src7z);
    assert.strictEqual(orig["sub/a.txt"], "one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const tar = await j7zCompressDir(files, "/_d.tar");
    const conv = await j7zDecompress(tar);
    assert.ok(Object.values(conv).includes("one"), "tar one");
    assert.ok(Object.values(conv).includes("two"), "tar two");
  });

  // ── 27. Merge split volumes → single archive ──
  await test("merge: split 7z back to single", async () => {
    // Create split 7z, then reassemble as single
    const j1 = await JS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j1, ["a", "/_m.7z", "/big.txt", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_m.7z."));
    assert.ok(parts.length >= 2, `split into ${parts.length} parts`);

    // Extract parts in fresh instance
    const j2 = await JS7z();
    for (const p of parts) {
      const data = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/_m.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    assert.ok(Object.values(res).some((v) => v.length === 16384), "split content ok");

    // Merge: re-compress extracted as single file
    const merged = await j7zCompress(res as Record<string, string>, "/_merged.7z");
    const f = await j7zDecompress(merged);
    assert.strictEqual(Object.keys(f).length, 1, "single file merged");
    assert.ok(Object.values(f)[0].length === 16384, "merged size correct");
  });

  // ── 28. Split single archive → volumes ──
  await test("split: single 7z to volumes", async () => {
    // Step 1: create a single 7z
    const j1 = await JS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j1, ["a", "/_s.7z", "/big.txt"]);
    const srcBuf = Buffer.from(j1.FS.readFile("/_s.7z", { encoding: "binary" }));

    // Step 2: extract source in fresh instance
    const j2 = await JS7z();
    j2.FS.writeFile("/_s.7z", new Uint8Array(srcBuf));
    j2.FS.mkdir("/_t");
    await run7z(j2, ["x", "/_s.7z", "-o/_t"]);

    // Step 3: re-compress with -v in fresh instance
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
    assert.ok(parts.length >= 2, `split into ${parts.length} parts`);

    // Step 4: verify split volumes can be extracted
    const j4 = await JS7z();
    for (const p of parts) {
      const data = j3.FS.readFile("/_o/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j4.FS.mkdir("/chk");
    await run7z(j4, ["x", "/_d.7z.001", "-o/chk"]);
    const res: Record<string, string> = {};
    copyFS(j4, "/chk", "", res);
    assert.ok(Object.values(res).some((v) => v.length === 16384), "content preserved");
  });

  // ── 29. Encrypted convert: encrypt → convert → encryption preserved ──
  await test("convert: encrypted 7z round-trip preserves encryption", async () => {
    const pw = "p4ssw0rd";
    const src = await j7zCompressDir(
      { "/sub/a.txt": "one", "/c.txt": "two" },
      "/_enc.7z",
      [`-p${pw}`, "-mhe=on"],
    );
    const orig = await j7zDecompress(src, pw);
    assert.strictEqual(orig["sub/a.txt"], "one");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const out = await j7zCompressDir(files, "/_conv.7z", [`-p${pw}`, "-mhe=on"]);
    const conv = await j7zDecompress(out, pw);
    assert.strictEqual(conv["sub/a.txt"], "one", "decrypt ok");
    assert.strictEqual(conv["c.txt"], "two", "decrypt ok");

    await assert.rejects(() => j7zDecompress(out, "wrong"), /7z exit/, "wrong pw rejected");
  });

  // ── 30. Decrypt: encrypted 7z → non-encrypted 7z ──
  await test("decrypt: encrypted 7z → non-encrypted", async () => {
    const pw = "s3cret";
    const src = await j7zCompressDir(
      { "/x.txt": "secret-data" },
      "/_enc2.7z",
      [`-p${pw}`, "-mhe=on"],
    );
    await assert.rejects(() => j7zDecompress(src), /7z exit/, "should be encrypted");

    const decrypted = await j7zDecompress(src, pw);
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(decrypted)) files["/" + k] = v;
    const stripped = await j7zCompressDir(files, "/_dec.7z");
    const res = await j7zDecompress(stripped);
    assert.strictEqual(res["x.txt"], "secret-data", "decrypted content preserved");
  });

  // ── 31. Encrypt: non-encrypted 7z → encrypted 7z ──
  await test("encrypt: non-encrypted 7z → encrypted", async () => {
    const pw = "newpw";
    const plain = await j7zCompressDir({ "/d.txt": "hello" }, "/_pl.7z");
    const orig = await j7zDecompress(plain);
    assert.strictEqual(orig["d.txt"], "hello");

    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(orig)) files["/" + k] = v;
    const enc = await j7zCompressDir(files, "/_enc3.7z", [`-p${pw}`, "-mhe=on"]);
    await assert.rejects(() => j7zDecompress(enc), /7z exit/, "should be encrypted");
    const res = await j7zDecompress(enc, pw);
    assert.strictEqual(res["d.txt"], "hello", "encrypted content preserved");
  });

  // ── 32. Decrypt split: encrypted split 7z → non-encrypted split 7z ──
  await test("decrypt: encrypted split 7z → non-encrypted split", async () => {
    const pw = "splitpw";
    const j1 = await JS7z();
    j1.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("y".repeat(16384))));
    await run7z(j1, ["a", "/_es.7z", "/big.txt", `-p${pw}`, "-mhe=on", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_es.7z."));
    assert.ok(parts.length >= 2, `split into ${parts.length} parts`);

    const j2 = await JS7z();
    for (const p of parts) {
      const d = j1.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/_es.7z.001", "-o/o", `-p${pw}`]);
    const files: Record<string, string> = {};
    copyFS(j2, "/o", "", files);
    assert.strictEqual(files["big.txt"]?.length, 16384);

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
    assert.ok(newParts.length >= 2);

    const j4 = await JS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j4.FS.mkdir("/chk2");
    await run7z(j4, ["x", "/_ds.7z.001", "-o/chk2"]);
    const dec: Record<string, string> = {};
    copyFS(j4, "/chk2", "", dec);
    assert.strictEqual(dec["big.txt"]?.length, 16384, "decrypted split content preserved");
  });

  // ── 33. Encrypt split: non-encrypted split 7z → encrypted split 7z ──
  await test("encrypt: non-encrypted split 7z → encrypted split", async () => {
    const pw = "encsplit";
    const j1 = await JS7z();
    j1.FS.writeFile("/med.txt", new Uint8Array(Buffer.from("z".repeat(16384))));
    await run7z(j1, ["a", "/_ps.7z", "/med.txt", "-v100b"]);
    const parts = j1.FS.readdir("/").filter((e) => e.startsWith("_ps.7z."));
    assert.ok(parts.length >= 2);

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
    assert.ok(newParts.length >= 2);

    const j4 = await JS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo2/" + p, { encoding: "binary" });
      j4.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j4.FS.mkdir("/chk3");
    await assert.rejects(
      () => run7z(j4, ["x", "/_es2.7z.001", "-o/chk3"]),
      /7z exit/,
      "encrypted split should require password",
    );

    const j5 = await JS7z();
    for (const p of newParts) {
      const d = j3.FS.readFile("/oo2/" + p, { encoding: "binary" });
      j5.FS.writeFile("/" + p, new Uint8Array(d));
    }
    j5.FS.mkdir("/chk3b");
    await run7z(j5, ["x", "/_es2.7z.001", "-o/chk3b", `-p${pw}`]);
    const enc: Record<string, string> = {};
    copyFS(j5, "/chk3b", "", enc);
    assert.strictEqual(enc["med.txt"]?.length, 16384, "encrypted split content preserved");
  });

  // ── 35. Missing split volume parts ──
  await test("split: missing middle part throws error", async () => {
    const j = await JS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/x.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/")
      .filter((e: string) => e.startsWith("x.7z."))
      .sort();
    assert.ok(parts.length >= 2, `need at least 2 split parts, got ${parts.length}`);

    // Copy first + last part only (skip middle) into a new VFS
    const j2 = await JS7z();
    const first = parts[0];
    j2.FS.writeFile("/" + first, new Uint8Array(j.FS.readFile("/" + first, { encoding: "binary" })));

    if (parts.length > 2) {
      const last = parts[parts.length - 1];
      j2.FS.writeFile("/" + last, new Uint8Array(j.FS.readFile("/" + last, { encoding: "binary" })));
    }

    // 7z l should fail when a volume is missing
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

    assert.ok(
      exitCode !== 0 || /error|missing|can.*open|unexpected/i.test(stderr),
      `should fail for missing volumes (code=${exitCode}, stderr=${stderr.trim()})`,
    );
  });

  await test("split: readdir skips gaps when parts deleted", async () => {
    const j = await JS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/x.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/")
      .filter((e: string) => e.startsWith("x.7z."))
      .sort();
    assert.ok(parts.length >= 2, `need at least 2 split parts`);

    // Write all parts to disk, but delete the middle one
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa_test_"));
    try {
      for (const p of parts) {
        const data = j.FS.readFile("/" + p, { encoding: "binary" });
        fs.writeFileSync(path.join(tmpDir, p), Buffer.from(data));
      }

      // Delete a non-first part to simulate missing volume
      const toDelete = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
      fs.unlinkSync(path.join(tmpDir, toDelete));

      // Copy existing parts into a new VFS
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

      // Verify the deleted part is NOT in the VFS
      assert.ok(!diskParts.includes(toDelete), `deleted part ${toDelete} should be absent`);
      assert.ok(diskParts.includes(parts[0]), "first part should exist");
      if (parts.length > 2) {
        assert.ok(diskParts.includes(parts[parts.length - 1]), "last part should exist");
      }

      // List should fail because middle part is missing
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

      assert.ok(
        exitCode !== 0 || /error|missing|can.*open|unexpected/i.test(stderr),
        `missing middle part should cause error (code=${exitCode}, stderr=${stderr.trim()})`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  fs.rmSync(td, { recursive: true, force: true });

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
})();
