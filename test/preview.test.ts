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
  j7zSelective,
  createWrapped,
  walkFS,
  passed,
  failed,
} from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z = require("js7z-tools") as (opts?: Record<string, unknown>) => Promise<JS7zInstance>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zstd = require("@bokuweb/zstd-wasm") as {
  init: () => Promise<void>;
  compress: (data: Uint8Array, level?: number) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
};

import type { JS7zInstance } from "./helpers";

// ════════════════════════════════════════════════════════════════════
void (async () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
  console.log("\n=== Smart Archive — Preview & Selective Extract Tests ===\n");

  // ── Format matrix (mirrors FORMAT_TABLE from constants.ts) ──
  interface Fmt {
    ext: string;
    wraps: boolean;
    j7z: boolean;
    la: boolean;
    short: string[];
  }
  const FM: Fmt[] = [
    { ext: "7z", wraps: false, j7z: true, la: true, short: [] },
    { ext: "zip", wraps: false, j7z: true, la: true, short: [] },
    { ext: "tar", wraps: false, j7z: true, la: true, short: [] },
    { ext: "tar.gz", wraps: true, j7z: false, la: true, short: ["tgz"] },
    { ext: "tar.bz2", wraps: true, j7z: false, la: true, short: ["tbz2", "tbz"] },
    { ext: "tar.xz", wraps: true, j7z: false, la: true, short: ["txz"] },
    { ext: "tar.zst", wraps: true, j7z: false, la: true, short: ["tzst"] },
    { ext: "tar.lz", wraps: true, j7z: false, la: true, short: ["tlz"] },
    { ext: "tar.lzma", wraps: true, j7z: false, la: true, short: [] },
    { ext: "gz", wraps: false, j7z: true, la: false, short: [] },
    { ext: "bz2", wraps: false, j7z: true, la: false, short: [] },
    { ext: "xz", wraps: false, j7z: true, la: false, short: [] },
  ];

  const stdFiles = { "/d/a.txt": "a", "/d/b.txt": "b", "/e/c.txt": "c" };
  const files10: Record<string, string> = {};
  for (let i = 1; i <= 10; i++) files10[`/many/${i}.txt`] = `file-${i}`;

  // ── 1. Selective extraction driven by format matrix ──
  for (const f of FM) {
    if (f.wraps) {
      for (const ext of [f.ext, ...f.short]) {
        if (f.j7z)
          await test(`7z selective: .${ext}`, async () => {
            const b = await createWrapped(stdFiles, ext);
            const r = await j7zSelective(b, ["d/a.txt"]);
            assert.strictEqual(r["d/a.txt"], "a");
            assert.strictEqual(
              Object.keys(r).filter((k) => !(k in { "d/a.txt": 1 })).length,
              0,
            );
          });
      }
    } else if (f.ext === "gz" || f.ext === "bz2" || f.ext === "xz") {
      if (f.j7z)
        await test(`7z selective: .${f.ext}`, async () => {
          const b = await j7zCompress({ "/data.txt": f.ext }, "/t." + f.ext);
          await j7zSelective(b, ["data.txt"]);
        });
    } else {
      if (f.j7z) {
        await test(`7z selective: .${f.ext} single`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(
            Object.keys(r).filter((k) => !(k in { "d/a.txt": 1 })).length,
            0,
          );
        });
        await test(`7z selective: .${f.ext} multi`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt", "d/b.txt"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(r["d/b.txt"], "b");
          assert.strictEqual(
            Object.keys(r).filter((k) => !(k in { "d/a.txt": 1, "d/b.txt": 1 })).length,
            0,
          );
        });
        await test(`7z selective: .${f.ext} dir`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(r["d/b.txt"], "b");
          assert.strictEqual(Object.keys(r).length, 2);
        });
      }
    }
  }

  // ── 2. Edge cases ──
  await test("7z selective: WIM", async () => {
    const j = await JS7z();
    mkdirP(j, "/src");
    j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
    j.FS.writeFile("/src/b.txt", new Uint8Array(Buffer.from("no")));
    await run7z(j, ["a", "-twim", "/t.wim", "/src"]);
    const buf = Buffer.from(j.FS.readFile("/t.wim", { encoding: "binary" }));
    const r = await j7zSelective(buf, ["src/a.txt"]);
    assert.strictEqual(r["src/a.txt"], "wim");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  await test("7z selective: nonexistent path", async () => {
    const b = await j7zCompressDir({ "/f.txt": "x" }, "/t.7z");
    const r = await j7zSelective(b, ["no.txt"]);
    assert.strictEqual(Object.keys(r).length, 0);
  });
  await test("7z selective: 1-of-10", async () => {
    const b = await j7zCompressDir(files10, "/t.7z");
    const r = await j7zSelective(b, ["many/5.txt"]);
    assert.strictEqual(r["many/5.txt"], "file-5");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  // ── 3. Encrypted ──
  const encFiles = { "/f.txt": "enc" };
  await test("7z selective: enc 7z correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.7z", ["-pp4ss", "-mhe=on"]);
    const r = await j7zSelective(b, ["f.txt"], "p4ss");
    assert.strictEqual(r["f.txt"], "enc");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  await test("7z selective: enc 7z wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.7z", ["-pp4ss", "-mhe=on"]);
    try {
      await j7zSelective(b, ["f.txt"], "wrong");
      assert.fail();
    } catch (er) {
      assert.ok((er as Error).message.includes("7z exit"));
    }
  });
  await test("7z selective: enc ZIP correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    const r = await j7zSelective(b, ["f.txt"], "zip");
    assert.strictEqual(r["f.txt"], "enc");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  await test("7z selective: enc ZIP wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    try {
      await j7zSelective(b, ["f.txt"], "wrong");
      assert.fail();
    } catch (er) {
      assert.ok((er as Error).message.includes("7z exit"));
    }
  });
  // ── 4. Two-step 7z x for wrapped formats (7z l can't recurse into inner tar) ──
  for (const ext of ["tar.xz", "tar.gz", "tar.bz2", "tgz", "txz"]) {
    await test(`7z x-x-ls: .${ext}`, async () => {
      const b = await createWrapped(stdFiles, ext);
      // Step 1: extract outer layer
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
      // Step 2: find inner .tar and extract it
      const top = j1.FS.readdir("/_ls1").filter((e: string) => e !== "." && e !== "..");
      assert.ok(
        top.some((e: string) => e.endsWith(".tar")),
        `${ext}: no .tar found in ${top}`,
      );
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
      assert.ok(paths.length > 0, `${ext}: expected entries, got 0`);
      assert.ok(
        paths.some((p) => p.includes("d/a.txt")),
        `${ext}: missing d/a.txt in ${paths}`,
      );
    });
  }

  // ── 5. zstd compression roundtrip (zstd-wasm self-verify; LA may not support zstd) ──
  await test("zstd roundtrip: compress then self-decompress", async () => {
    const b = await createWrapped(stdFiles, "tar.zst");
    assert.ok(b.length < 4096, `zstd archive too large: ${b.length}`);
    // Self-verify: zstd-wasm can decompress its own output
    const dec = zstd.decompress(b);
    assert.ok(dec.length > 100, `decompressed too small: ${dec.length}`);
    // The decompressed data is a tar; extract with 7z
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
    assert.ok(paths.includes("d/a.txt"), `missing d/a.txt in ${paths}`);
    assert.ok(paths.includes("d/b.txt"), `missing d/b.txt in ${paths}`);
  });

  fs.rmSync(td, { recursive: true, force: true });

  // ════════════════════════════════════════════════════════════════════
  // parse7zListing tests
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
      if (key === "Path") { flush(); curPath = val; }
      else if (key === "Size" && !curSize) { curSize = parseInt(val, 10) || 0; }
      else if (key === "Attributes") { curAttr = val; }
    }
    flush();

    // Filter out archive self-reference
    const volBase = archiveName.match(/^(.+\.(?:7z|zip|wim))\.\d+$/i)?.[1] ?? null;
    return results.filter((r) => {
      if (r.path === `/${archiveName}` || r.path === archiveName) return false;
      if (volBase && (r.path === `/${volBase}` || r.path === volBase)) return false;
      return true;
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // markNoisyDirs tests
  // ════════════════════════════════════════════════════════════════════

  const { minimatch } = require("minimatch") as { minimatch: (p: string, pattern: string, opts?: Record<string, unknown>) => boolean };

  function markNoisyDirs(nodes: TreeNode[], noisyPatterns: string[]): void {
    if (noisyPatterns.length === 0) return;
    for (const node of nodes) {
      if (node.kind === "DIRECTORY") {
        for (const pattern of noisyPatterns) {
          if (
            minimatch(node.path, pattern, { dot: true }) ||
            minimatch(node.name, pattern, { dot: true })
          ) {
            node.collapsed = true;
            break;
          }
          for (const seg of node.path.split("/")) {
            if (minimatch(seg, pattern, { dot: true })) {
              node.collapsed = true;
              break;
            }
          }
          if (node.collapsed) break;
        }
      }
      if (node.children) markNoisyDirs(node.children, noisyPatterns);
    }
  }

  interface FlatEntry { path: string; size: number; type: string; }
  interface TreeNode {
    name: string;
    path: string;
    size: number;
    kind: string;
    children?: TreeNode[];
    collapsed?: boolean;
  }

  function buildTree(entries: FlatEntry[], _archiveName: string): TreeNode[] {
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
              name: seg, path: entry.path, size: entry.size,
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

  await test("parse7zListing: basic files and dirs", () => {
    const stdout = mock7zListing([
      { path: "/test.7z", size: 100, attr: "A" },
      { path: "src", size: 0, attr: "D" },
      { path: "src/index.js", size: 42, attr: "A" },
      { path: "src/lib", size: 0, attr: "D" },
      { path: "src/lib/util.js", size: 10, attr: "A" },
      { path: "package.json", size: 5, attr: "A" },
    ]);
    const r = parse7zListing(stdout, "test.7z");
    assert.strictEqual(r.length, 5, "should filter self-entry");
    assert.strictEqual(r[0].path, "src");
    assert.strictEqual(r[0].type, "DIRECTORY");
    assert.strictEqual(r[1].path, "src/index.js");
    assert.strictEqual(r[1].type, "REGULAR_FILE");
    assert.strictEqual(r[1].size, 42);
    assert.strictEqual(r[4].path, "package.json");
    assert.strictEqual(r[4].size, 5);
  });

  await test("parse7zListing: skips archive self-reference", () => {
    const stdout = mock7zListing([
      { path: "/archive.7z", size: 200, attr: "A" },
      { path: "/archive.7z", size: 200, attr: "A" }, // without leading slash
      { path: "readme.md", size: 30, attr: "A" },
    ]);
    // Without leading slash
    const stdout2 = `Path = archive.7z\nSize = 200\nAttributes = A\n\nPath = readme.md\nSize = 30\nAttributes = A\n\n`;
    const r = parse7zListing(stdout2, "archive.7z");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].path, "readme.md");
  });

  await test("parse7zListing: empty output returns empty", () => {
    assert.strictEqual(parse7zListing("", "x.7z").length, 0);
    assert.strictEqual(parse7zListing("7-Zip ...\n---\n", "x.7z").length, 0);
  });

  await test("parse7zListing: handles 7z header lines gracefully", () => {
    const stdout =
      "7-Zip (z) 25.01 ...\n\n" +
      "Scanning the drive:\n" +
      "  0M Scan /\n" +
      "Path = dir/file.txt\nSize = 100\nAttributes = A\n\n" +
      "Path = dir\nSize = 0\nAttributes = D\n\n";
    const r = parse7zListing(stdout, "x.7z");
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].path, "dir/file.txt");
    assert.strictEqual(r[0].size, 100);
    assert.strictEqual(r[1].type, "DIRECTORY");
  });

  await test("parse7zListing: split volume self-reference filtered", () => {
    const stdout = mock7zListing([
      { path: "/x.7z.001", size: 100, attr: "A" },
      { path: "/x.7z", size: 80, attr: "A" }, // logical base
      { path: "data.txt", size: 20, attr: "A" },
    ]);
    const r = parse7zListing(stdout, "x.7z.001");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].path, "data.txt");
  });

  await test("parse7zListing: size only set on first occurrence", () => {
    const stdout =
      "Path = app.js\nSize = 42\n\n" +
      "Modified = 2024-01-01 00:00:00\n\n" +
      "Path = readme.md\nSize = 100\nAttributes = A\n\n";
    const r = parse7zListing(stdout, "a.7z");
    assert.strictEqual(r[0].path, "app.js");
    assert.strictEqual(r[0].size, 42);
    assert.strictEqual(r[1].size, 100);
  });

  await test("parse7zListing: CJK filenames preserved", () => {
    const stdout = mock7zListing([
      { path: "中文文件.txt", size: 10, attr: "A" },
      { path: "日本語フォルダ", size: 0, attr: "D" },
    ]);
    const r = parse7zListing(stdout, "a.7z");
    assert.strictEqual(r.length, 2);
    assert.ok(r.some((e) => e.path.includes("中文文件")));
    assert.ok(r.some((e) => e.type === "DIRECTORY"));
  });

  // ════════════════════════════════════════════════════════════════════
  // markNoisyDirs tests
  // ════════════════════════════════════════════════════════════════════

  await test("markNoisyDirs: collapses node_modules at root", () => {
    const entries: { path: string; size: number; type: string }[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/index.js", size: 100, type: "REGULAR_FILE" },
      { path: "src/index.js", size: 42, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.7z");
    markNoisyDirs(tree, ["node_modules", ".git"]);
    const nm = tree.find((n) => n.name === "node_modules");
    assert.ok(nm, "node_modules should exist in tree");
    assert.strictEqual(nm!.collapsed, true, "node_modules should be collapsed");
    const src = tree.find((n) => n.name === "src");
    assert.ok(src);
    assert.strictEqual(src!.collapsed, undefined, "src should not be collapsed");
  });

  await test("markNoisyDirs: collapses nested noisy dirs", () => {
    const entries: FlatEntry[] = [
      { path: "project", size: 0, type: "DIRECTORY" },
      { path: "project/src", size: 0, type: "DIRECTORY" },
      { path: "project/src/node_modules", size: 0, type: "DIRECTORY" },
      { path: "project/src/node_modules/lib.js", size: 10, type: "REGULAR_FILE" },
      { path: "project/.git", size: 0, type: "DIRECTORY" },
      { path: "project/.git/HEAD", size: 5, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    markNoisyDirs(tree, ["node_modules", ".git"]);
    const project = tree.find((n) => n.name === "project");
    assert.strictEqual(project!.collapsed, undefined);
    // .git is direct child of project
    const git = project!.children!.find((c) => c.name === ".git");
    assert.strictEqual(git!.collapsed, true);
    // node_modules is inside src
    const src = project!.children!.find((c) => c.name === "src");
    assert.ok(src);
    const nm = src!.children!.find((c) => c.name === "node_modules");
    assert.strictEqual(nm!.collapsed, true);
  });

  await test("markNoisyDirs: children of noisy dir also collapsed", () => {
    const entries: { path: string; size: number; type: string }[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/lib", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/lib/app.js", size: 50, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "t.7z");
    markNoisyDirs(tree, ["node_modules"]);
    const nm = tree[0];
    assert.strictEqual(nm.collapsed, true);
    const express = nm.children![0];
    assert.strictEqual(express.collapsed, true, "express inside node_modules also collapsed");
    const lib = express.children![0];
    assert.strictEqual(lib.collapsed, true, "lib inside express also collapsed");
  });

  await test("markNoisyDirs: empty patterns does nothing", () => {
    const entries: { path: string; size: number; type: string }[] = [
      { path: "node_modules/lib.js", size: 10, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "t.7z");
    markNoisyDirs(tree, []);
    assert.strictEqual(tree[0].collapsed, undefined);
  });

  await test("markNoisyDirs: glob patterns work", () => {
    const entries: { path: string; size: number; type: string }[] = [
      { path: "logs", size: 0, type: "DIRECTORY" },
      { path: "logs/error.log", size: 20, type: "REGULAR_FILE" },
      { path: "logs/info.log", size: 15, type: "REGULAR_FILE" },
      { path: "src/main.ts", size: 30, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "t.7z");
    markNoisyDirs(tree, ["*.log"]);
    const logs = tree.find((n) => n.name === "logs");
    // logs dir with children that match *.log
    assert.strictEqual(logs!.collapsed, undefined, "*.log matches files, not dirs");
  });

  await test("markNoisyDirs: dotfile dirs collapsed", () => {
    const entries: { path: string; size: number; type: string }[] = [
      { path: ".npm", size: 0, type: "DIRECTORY" },
      { path: ".npm/_cacache", size: 0, type: "DIRECTORY" },
      { path: ".vscode", size: 0, type: "DIRECTORY" },
      { path: ".vscode/settings.json", size: 8, type: "REGULAR_FILE" },
      { path: "src/app.ts", size: 12, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "t.7z");
    markNoisyDirs(tree, [".npm", ".vscode"]);
    assert.strictEqual(tree.find((n) => n.name === ".npm")!.collapsed, true);
    assert.strictEqual(tree.find((n) => n.name === ".vscode")!.collapsed, true);
    assert.strictEqual(tree.find((n) => n.name === "src")!.collapsed, undefined);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
})();
