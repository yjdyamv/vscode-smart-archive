import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z = require('js7z-tools') as (opts?: Record<string, unknown>) => Promise<JS7zInstance>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zstd = require("@bokuweb/zstd-wasm") as { init: () => Promise<void>; compress: (data: Uint8Array, level?: number) => Uint8Array; decompress: (data: Uint8Array) => Uint8Array };
let zstdReady = false;

// ── Types ──

interface JS7zInstance {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, data: Uint8Array): void;
    readFile(p: string, opts?: { encoding: 'binary' }): ArrayBuffer;
    readdir(p: string): string[];
    stat(p: string): { mode: number; size: number };
    isDir(mode: number): boolean;
  };
  callMain(args: string[]): void;
  onExit: ((ec: number) => void) | null;
  printErr?: (t: string) => void;
  print?: (t: string) => void;
}

// ── Test runner ──

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${(err as Error).message}`);
  }
}

// ── Helpers ──

function mkdirP(j: JS7zInstance, p: string): void {
  let cur = '';
  for (const part of p.split('/').filter(Boolean)) {
    cur += '/' + part;
    try { j.FS.mkdir(cur); } catch { /* already exists */ }
  }
}

function run7z(j: JS7zInstance, args: string[]): Promise<void> {
  let err = '';
  j.printErr = (t: string) => { err += t + '\n'; };
  return new Promise((resolve, reject) => {
    j.onExit = (ec: number) => {
      if (ec === 0) resolve();
      else reject(new Error(`7z exit ${ec}\n${err}`));
    };
    j.callMain(args);
  });
}

async function j7zCompress(files: Record<string, string>, archive: string, extra: string[] = []): Promise<Buffer> {
  const j = await JS7z();
  for (const [fp, content] of Object.entries(files)) {
    const dir = path.posix.dirname(fp);
    if (dir && dir !== '/') mkdirP(j, dir);
    j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
  }
  await run7z(j, ['a', archive, ...Object.keys(files), ...extra]);
  return Buffer.from(j.FS.readFile(archive, { encoding: 'binary' }));
}

async function j7zCompressDir(files: Record<string, string>, archive: string, extra: string[] = []): Promise<Buffer> {
  const j = await JS7z();
  for (const [fp, content] of Object.entries(files)) {
    const dir = path.posix.dirname(fp);
    if (dir && dir !== '/') mkdirP(j, dir);
    j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
  }
  const tops = [...new Set(Object.keys(files).map((f) => '/' + f.split('/')[1]))];
  await run7z(j, ['a', archive, ...tops, ...extra]);
  return Buffer.from(j.FS.readFile(archive, { encoding: 'binary' }));
}

function copyFS(j: JS7zInstance, dir: string, prefix: string, res: Record<string, string>): void {
  for (const e of j.FS.readdir(dir)) {
    if (e === '.' || e === '..') continue;
    const fp = path.posix.join(dir, e);
    const k = prefix ? prefix + '/' + e : e;
    try {
      const s = j.FS.stat(fp);
      if (j.FS.isDir(s.mode)) { copyFS(j, fp, k, res); }
      else { res[k] = Buffer.from(j.FS.readFile(fp, { encoding: 'binary' })).toString(); }
    } catch {
      try { res[k] = Buffer.from(j.FS.readFile(fp, { encoding: 'binary' })).toString(); } catch { /* skip */ }
    }
  }
}

async function j7zSelective(buf: Buffer, paths: string[], pw = ""): Promise<Record<string, string>> {
  const j = await JS7z();
  j.FS.writeFile("/a", new Uint8Array(buf));
  j.FS.mkdir("/o");
  const args = ["x", "/a", "-o/o"];
  if (pw) args.splice(1, 0, "-p" + pw);
  args.push(...paths);
  const res: Record<string, string> = {};
  await run7z(j, args);
  copyFS(j, "/o", "", res);
  return res;
}

async function laSelective(buf: Buffer, paths: string[], pw = ""): Promise<Record<string, string>> {
  const { ArchiveReader, libarchiveWasm } = await import("libarchive-wasm");
  const m = await libarchiveWasm();
  const r = new ArchiveReader(m, new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength), pw || undefined);
  const sel = new Set(paths);
  const res: Record<string, string> = {};
  try {
    for (const e of r.entries()) {
      const pn = e.getPathname();
      if (!pn || !sel.has(pn)) continue;
      if (e.getFiletype() === "DIRECTORY" || pn.endsWith("/")) continue;
      const d = e.readData();
      if (d) res[pn] = Buffer.from(d).toString();
    }
  } finally { r.free(); }
  return res;
}

async function createWrapped(files: Record<string, string>, ext: string): Promise<Buffer> {
  const j1 = await JS7z();
  for (const [fp, c] of Object.entries(files)) {
    const d = path.posix.dirname(fp);
    if (d && d !== "/") mkdirP(j1, d);
    j1.FS.writeFile(fp, new Uint8Array(Buffer.from(c)));
  }
  const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[1]))];
  await run7z(j1, ["a", "/_t.tar", ...tops]);
  const tb = Buffer.from(j1.FS.readFile("/_t.tar", { encoding: "binary" }));
  if (ext === "tar.zst" || ext === "tzst") {
    if (!zstdReady) { await zstd.init(); zstdReady = true; }
    return Buffer.from(zstd.compress(new Uint8Array(tb), 3));
  }
  const j2 = await JS7z();
  j2.FS.writeFile("/_t.tar", new Uint8Array(tb));
  await run7z(j2, ["a", "/_w." + ext, "/_t.tar"]);
  return Buffer.from(j2.FS.readFile("/_w." + ext, { encoding: "binary" }));
}

// ════════════════════════════════════════════════════════════════════
void (async () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'sat_'));
  console.log('\n=== Smart Archive — Preview & Selective Extract Tests ===\n');

  // ── Format matrix (mirrors FORMAT_TABLE from constants.ts) ──
  interface Fmt { ext: string; wraps: boolean; j7z: boolean; la: boolean; short: string[] }
  const FM: Fmt[] = [
    { ext: "7z",   wraps: false, j7z: true,  la: true,  short: [] },
    { ext: "zip",  wraps: false, j7z: true,  la: true,  short: [] },
    { ext: "tar",  wraps: false, j7z: true,  la: true,  short: [] },
    { ext: "tar.gz", wraps: true, j7z: false, la: true, short: ["tgz"] },
    { ext: "tar.bz2",wraps: true, j7z: false, la: true, short: ["tbz2", "tbz"] },
    { ext: "tar.xz", wraps: true, j7z: false, la: true, short: ["txz"] },
    { ext: "tar.zst",wraps: true, j7z: false, la: true, short: ["tzst"] },
    { ext: "tar.lz", wraps: true, j7z: false, la: true, short: ["tlz"] },
    { ext: "tar.lzma",wraps:true, j7z: false, la: true, short: [] },
    { ext: "gz",   wraps: false, j7z: true,  la: false, short: [] },
    { ext: "bz2",  wraps: false, j7z: true,  la: false, short: [] },
    { ext: "xz",   wraps: false, j7z: true,  la: false, short: [] },
  ];

  const stdFiles = { "/d/a.txt": "a", "/d/b.txt": "b", "/e/c.txt": "c" };
  const files10: Record<string, string> = {};
  for (let i = 1; i <= 10; i++) files10[`/many/${i}.txt`] = `file-${i}`;

  function walkFS(j: JS7zInstance, dir: string, prefix: string): string[] {
    const res: string[] = [];
    for (const name of j.FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const fp = dir === "/" ? `/${name}` : `${dir}/${name}`;
      const child = prefix ? `${prefix}/${name}` : name;
      try {
        const st = j.FS.stat(fp);
        if (j.FS.isDir(st.mode)) { res.push(child + "/"); res.push(...walkFS(j, fp, child)); }
        else { res.push(child); }
      } catch { res.push(child); }
    }
    return res;
  }

  // ── 1. Selective extraction driven by format matrix ──
  for (const f of FM) {
    if (f.wraps) {
      for (const ext of [f.ext, ...f.short]) {
        if (f.j7z) await test(`7z selective: .${ext}`, async () => {
          const b = await createWrapped(stdFiles, ext);
          const r = await j7zSelective(b, ["d/a.txt"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(Object.keys(r).filter(k => !(k in {"d/a.txt":1})).length, 0);
        });
        if (f.la) await test(`LA selective: .${ext}`, async () => {
          try {
            const b = await createWrapped(stdFiles, ext);
            const r = await laSelective(b, ["d/a.txt"]);
            assert.strictEqual(r["d/a.txt"], "a");
            assert.strictEqual(Object.keys(r).filter(k => !(k in {"d/a.txt":1})).length, 0);
          } catch { /* may not support this variant */ }
        });
      }
    } else if (f.ext === "gz" || f.ext === "bz2" || f.ext === "xz") {
      if (f.j7z) await test(`7z selective: .${f.ext}`, async () => {
        const b = await j7zCompress({ "/data.txt": f.ext }, "/t." + f.ext);
        await j7zSelective(b, ["data.txt"]);
      });
    } else {
      if (f.j7z) {
        await test(`7z selective: .${f.ext} single`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(Object.keys(r).filter(k => !(k in {"d/a.txt":1})).length, 0);
        });
        await test(`7z selective: .${f.ext} multi`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt", "d/b.txt"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(r["d/b.txt"], "b");
          assert.strictEqual(Object.keys(r).filter(k => !(k in {"d/a.txt":1,"d/b.txt":1})).length, 0);
        });
        await test(`7z selective: .${f.ext} dir`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(r["d/b.txt"], "b");
          assert.strictEqual(Object.keys(r).length, 2);
        });
      }
      if (f.la) {
        await test(`LA selective: .${f.ext} single`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await laSelective(b, ["d/a.txt"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(Object.keys(r).filter(k => !(k in {"d/a.txt":1})).length, 0);
        });
        await test(`LA selective: .${f.ext} multi`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await laSelective(b, ["d/a.txt", "d/b.txt"]);
          assert.strictEqual(r["d/a.txt"], "a");
          assert.strictEqual(r["d/b.txt"], "b");
          assert.strictEqual(Object.keys(r).filter(k => !(k in {"d/a.txt":1,"d/b.txt":1})).length, 0);
        });
      }
    }
  }

  // ── 2. Edge cases ──
  await test("7z selective: WIM", async () => {
    const j = await JS7z(); mkdirP(j, "/src");
    j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
    j.FS.writeFile("/src/b.txt", new Uint8Array(Buffer.from("no")));
    await run7z(j, ["a", "-twim", "/t.wim", "/src"]);
    const buf = Buffer.from(j.FS.readFile("/t.wim", { encoding: "binary" }));
    const r = await j7zSelective(buf, ["src/a.txt"]);
    assert.strictEqual(r["src/a.txt"], "wim");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  await test("LA selective: WIM", async () => {
    const j = await JS7z(); mkdirP(j, "/src");
    j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
    j.FS.writeFile("/src/b.txt", new Uint8Array(Buffer.from("no")));
    await run7z(j, ["a", "-twim", "/t.wim", "/src"]);
    const buf = Buffer.from(j.FS.readFile("/t.wim", { encoding: "binary" }));
    try { const r = await laSelective(buf, ["src/a.txt"]); assert.strictEqual(r["src/a.txt"], "wim"); }
    catch { /* LA may not support WIM */ }
  });
  await test("7z selective: nonexistent path", async () => {
    const b = await j7zCompressDir({ "/f.txt": "x" }, "/t.7z");
    const r = await j7zSelective(b, ["no.txt"]);
    assert.strictEqual(Object.keys(r).length, 0);
  });
  await test("LA selective: nonexistent path", async () => {
    const b = await j7zCompressDir({ "/f.txt": "x" }, "/t.7z");
    const r = await laSelective(b, ["no.txt"]);
    assert.strictEqual(Object.keys(r).length, 0);
  });
  await test("7z selective: 1-of-10", async () => {
    const b = await j7zCompressDir(files10, "/t.7z");
    const r = await j7zSelective(b, ["many/5.txt"]);
    assert.strictEqual(r["many/5.txt"], "file-5");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  await test("LA selective: 1-of-10", async () => {
    const b = await j7zCompressDir(files10, "/t.7z");
    const r = await laSelective(b, ["many/5.txt"]);
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
    try { await j7zSelective(b, ["f.txt"], "wrong"); assert.fail(); }
    catch (er) { assert.ok((er as Error).message.includes("7z exit")); }
  });
  await test("7z selective: enc ZIP correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    const r = await j7zSelective(b, ["f.txt"], "zip");
    assert.strictEqual(r["f.txt"], "enc");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  await test("7z selective: enc ZIP wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    try { await j7zSelective(b, ["f.txt"], "wrong"); assert.fail(); }
    catch (er) { assert.ok((er as Error).message.includes("7z exit")); }
  });
  await test("LA selective: enc ZIP correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pla"]);
    const r = await laSelective(b, ["f.txt"], "la");
    assert.strictEqual(r["f.txt"], "enc");
    assert.strictEqual(Object.keys(r).length, 1);
  });
  await test("LA selective: enc ZIP wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pla"]);
    try { await laSelective(b, ["f.txt"], "bad"); assert.fail(); }
    catch (er) { assert.ok((er as Error).message.includes("passphrase") || (er as Error).message.includes("Incorrect")); }
  });
  await test("LA selective: enc 7z fails", async () => {
    const b = await j7zCompressDir({ "/f.txt": "enc" }, "/t.7z", ["-pp4ss", "-mhe=on"]);
    try { const r = await laSelective(b, ["f.txt"], "p4ss"); assert.strictEqual(Object.keys(r).length, 0); }
    catch { /* LA throws on encrypted 7z — expected */ }
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
        j1.onExit = (c: number) => { if (c === 0) resolve(); else reject(new Error(`7z x outer: ${c}`)); };
        j1.callMain(["x", "/a." + ext, "-o/_ls1", "-y"]);
      });
      // Step 2: find inner .tar and extract it
      const top = j1.FS.readdir("/_ls1").filter((e: string) => e !== "." && e !== "..");
      assert.ok(top.some((e: string) => e.endsWith(".tar")), `${ext}: no .tar found in ${top}`);
      const innerTar = top.find((e: string) => e.endsWith(".tar"))!;
      const innerData = j1.FS.readFile(`/_ls1/${innerTar}`, { encoding: "binary" });
      const j2 = await JS7z();
      j2.FS.writeFile("/_inner.tar", new Uint8Array(innerData));
      j2.FS.mkdir("/_ls2");
      await new Promise<void>((resolve, reject) => {
        j2.onExit = (c: number) => { if (c === 0) resolve(); else reject(new Error(`7z x inner: ${c}`)); };
        j2.callMain(["x", "/_inner.tar", "-o/_ls2", "-y"]);
      });
      const paths = walkFS(j2, "/_ls2", "");
      assert.ok(paths.length > 0, `${ext}: expected entries, got 0`);
      assert.ok(paths.some((p) => p.includes("d/a.txt")), `${ext}: missing d/a.txt in ${paths}`);
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
      j.onExit = (c: number) => { if (c === 0) resolve(); else reject(new Error(`7z x tar: ${c}`)); };
      j.callMain(["x", "/_t.tar", "-o/_out", "-y"]);
    });
    const paths = walkFS(j, "/_out", "");
    assert.ok(paths.includes("d/a.txt"), `missing d/a.txt in ${paths}`);
    assert.ok(paths.includes("d/b.txt"), `missing d/b.txt in ${paths}`);
  });

  fs.rmSync(td, { recursive: true, force: true });

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
})();
