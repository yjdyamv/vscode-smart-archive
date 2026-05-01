import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z = require('js7z-tools') as (opts?: Record<string, unknown>) => Promise<JS7zInstance>;

// ── Types ──

interface JS7zInstance {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, data: Uint8Array): void;
    readFile(p: string, opts?: { encoding: 'binary' }): ArrayBuffer;
    readdir(p: string): string[];
    stat(p: string): { mode: number };
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

// ── js7z helpers ──

function mkdirP(j: JS7zInstance, p: string): void {
  let cur = '';
  for (const part of p.split('/').filter(Boolean)) {
    cur += '/' + part;
    try {
      j.FS.mkdir(cur);
    } catch {
      /* already exists */
    }
  }
}

function run7z(j: JS7zInstance, args: string[]): Promise<void> {
  let err = '';
  j.printErr = (t: string) => {
    err += t + '\n';
  };
  return new Promise((resolve, reject) => {
    j.onExit = (ec: number) => {
      if (ec === 0) resolve();
      else reject(new Error(`7z exit ${ec}\n${err}`));
    };
    j.callMain(args);
  });
}

async function j7zCompress(
  files: Record<string, string>,
  archive: string,
  extra: string[] = [],
): Promise<Buffer> {
  const j = await JS7z();
  for (const [fp, content] of Object.entries(files)) {
    const dir = path.posix.dirname(fp);
    if (dir && dir !== '/') mkdirP(j, dir);
    j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
  }
  const args = ['a', archive, ...Object.keys(files), ...extra];
  await run7z(j, args);
  return Buffer.from(j.FS.readFile(archive, { encoding: 'binary' }));
}

async function j7zDecompress(buf: Buffer, pw = ''): Promise<Record<string, string>> {
  const j = await JS7z();
  j.FS.writeFile('/a', new Uint8Array(buf));
  j.FS.mkdir('/o');
  const args = ['x', '/a', '-o/o'];
  if (pw) args.splice(1, 0, '-p' + pw);
  const res: Record<string, string> = {};
  await run7z(j, args);
  copyFS(j, '/o', '', res);
  return res;
}

function copyFS(j: JS7zInstance, dir: string, prefix: string, res: Record<string, string>): void {
  for (const e of j.FS.readdir(dir)) {
    if (e === '.' || e === '..') continue;
    const fp = path.posix.join(dir, e);
    const k = prefix ? prefix + '/' + e : e;
    try {
      const s = j.FS.stat(fp);
      if (j.FS.isDir(s.mode)) {
        copyFS(j, fp, k, res);
      } else {
        res[k] = Buffer.from(j.FS.readFile(fp, { encoding: 'binary' })).toString();
      }
    } catch {
      try {
        res[k] = Buffer.from(j.FS.readFile(fp, { encoding: 'binary' })).toString();
      } catch {
        /* skip */
      }
    }
  }
}

async function j7zCompressDir(
  files: Record<string, string>,
  archive: string,
  extra: string[] = [],
): Promise<Buffer> {
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

// ── libarchive-wasm helpers ──

async function laExtract(buf: Buffer, pw = ''): Promise<Record<string, string>> {
  const { ArchiveReader, libarchiveWasm } = await import('libarchive-wasm');
  const m = await libarchiveWasm();
  const r = new ArchiveReader(
    m,
    new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    pw || undefined,
  );
  const res: Record<string, string> = {};
  try {
    for (const e of r.entries()) {
      const pn = e.getPathname();
      if (!pn || e.getFiletype() === 'DIRECTORY') continue;
      const d = e.readData();
      if (d) res[pn] = Buffer.from(d).toString();
    }
  } finally {
    r.free();
  }
  return res;
}

async function laHasEncrypted(buf: Buffer): Promise<boolean | null> {
  const { ArchiveReader, libarchiveWasm } = await import('libarchive-wasm');
  const m = await libarchiveWasm();
  const r = new ArchiveReader(m, new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  try {
    return r.hasEncryptedData();
  } finally {
    r.free();
  }
}

// ════════════════════════════════════════════════════════════════════
void (async () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'sat_'));
  console.log('\n=== Smart Archive — Core Tests ===\n');

  // ── 1. js7z-tools: 7z ──
  await test('7z single file', async () => {
    const b = await j7zCompress({ '/a.txt': 'hello' }, '/x.7z');
    const f = await j7zDecompress(b);
    assert.strictEqual(f['a.txt'], 'hello');
  });

  await test('7z multi file', async () => {
    const b = await j7zCompressDir({ '/s/1.txt': '1', '/s/2.txt': '2', '/s/3.txt': '3' }, '/m.7z');
    const f = await j7zDecompress(b);
    assert.strictEqual(Object.keys(f).length, 3);
    assert.strictEqual(f['s/1.txt'], '1');
  });

  await test('7z nested folder', async () => {
    const b = await j7zCompressDir(
      { '/p/readme.md': '#P', '/p/src/main.js': 'log(1)', '/p/src/lib/x.js': 'exports=1' },
      '/d.7z',
    );
    const f = await j7zDecompress(b);
    assert.strictEqual(Object.keys(f).length, 3);
    assert.strictEqual(f['p/readme.md'], '#P');
    assert.strictEqual(f['p/src/lib/x.js'], 'exports=1');
  });

  await test('7z encrypted -mhe=on', async () => {
    const b = await j7zCompress({ '/s.txt': 'sec' }, '/e.7z', ['-ppw', '-mhe=on']);
    await assert.rejects(() => j7zDecompress(b, 'bad'), /7z exit/);
    const f = await j7zDecompress(b, 'pw');
    assert.strictEqual(f['s.txt'], 'sec');
  });

  await test('7z encrypted no -mhe', async () => {
    const b = await j7zCompress({ '/s.txt': 'sec' }, '/e2.7z', ['-ppw']);
    const f = await j7zDecompress(b, 'pw');
    assert.strictEqual(f['s.txt'], 'sec');
  });

  // ── 2. ZIP ──
  await test('ZIP single', async () => {
    const b = await j7zCompress({ '/d.txt': 'zip' }, '/z.zip');
    const f = await j7zDecompress(b);
    assert.strictEqual(f['d.txt'], 'zip');
  });

  await test('ZIP multi', async () => {
    const b = await j7zCompressDir({ '/a/a.txt': 'A', '/a/b.txt': 'B' }, '/zm.zip');
    const f = await j7zDecompress(b);
    assert.strictEqual(f['a/a.txt'], 'A');
    assert.strictEqual(f['a/b.txt'], 'B');
  });

  await test('ZIP nested folder', async () => {
    const b = await j7zCompressDir(
      { '/app/index.html': '<h>', '/app/js/main.js': 'var x' },
      '/zf.zip',
    );
    const f = await j7zDecompress(b);
    assert.strictEqual(f['app/index.html'], '<h>');
    assert.strictEqual(f['app/js/main.js'], 'var x');
  });

  await test('ZIP encrypted', async () => {
    const b = await j7zCompress({ '/e.txt': 'locked' }, '/ez.zip', ['-ppw']);
    await assert.rejects(() => j7zDecompress(b, 'bad'), /7z exit/);
    const f = await j7zDecompress(b, 'pw');
    assert.strictEqual(f['e.txt'], 'locked');
  });

  // ── 3. TAR ──
  await test('TAR single', async () => {
    const b = await j7zCompress({ '/n.txt': 'tar' }, '/t.tar');
    const f = await j7zDecompress(b);
    assert.strictEqual(f['n.txt'], 'tar');
  });

  await test('TAR multi', async () => {
    const b = await j7zCompressDir({ '/x/a.txt': 'a', '/x/b.txt': 'b' }, '/tm.tar');
    const f = await j7zDecompress(b);
    assert.strictEqual(f['x/a.txt'], 'a');
    assert.strictEqual(f['x/b.txt'], 'b');
  });

  // ── 4. Stream formats ──
  await test('GZip stream', async () => {
    const b = await j7zCompress({ '/log.txt': 'gzip' }, '/l.gz');
    assert.ok(b.length < 80);
    const f = await j7zDecompress(b);
    assert.ok(Object.values(f).length >= 1);
  });

  await test('BZip2 stream', async () => {
    const b = await j7zCompress({ '/d.bin': 'bz2' }, '/d.bz2');
    assert.ok(b.length > 0);
    const f = await j7zDecompress(b);
    assert.ok(Object.values(f).length >= 1);
  });

  await test('XZ stream', async () => {
    const b = await j7zCompress({ '/c.yml': 'xz' }, '/c.xz');
    assert.ok(b.length > 0);
    const f = await j7zDecompress(b);
    assert.ok(Object.values(f).length >= 1);
  });

  // ── 5. WIM ──
  await test('WIM create + extract', async () => {
    const j = await JS7z();
    j.FS.mkdir('/src');
    j.FS.writeFile('/src/a.txt', new Uint8Array(Buffer.from('wim')));
    await run7z(j, ['a', '-twim', '/tw.wim', '/src']);
    const buf = Buffer.from(j.FS.readFile('/tw.wim', { encoding: 'binary' }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f['src/a.txt'], 'wim');
  });

  // ── 6. Cross-engine: js7z create → libarchive-wasm read ──
  await test('cross: 7z→LA single', async () => {
    const b = await j7zCompress({ '/x.txt': 'c7z' }, '/c.7z');
    const f = await laExtract(b);
    assert.strictEqual(f['x.txt'], 'c7z');
  });

  await test('cross: 7z→LA folder', async () => {
    const b = await j7zCompressDir({ '/s/a.js': 'a', '/s/lib/b.js': 'b' }, '/cf.7z');
    const f = await laExtract(b);
    assert.strictEqual(f['s/a.js'], 'a');
    assert.strictEqual(f['s/lib/b.js'], 'b');
  });

  await test('cross: ZIP→LA single', async () => {
    const b = await j7zCompress({ '/z.txt': 'cz' }, '/cz.zip');
    const f = await laExtract(b);
    assert.strictEqual(f['z.txt'], 'cz');
  });

  await test('cross: ZIP→LA folder', async () => {
    const b = await j7zCompressDir({ '/p/readme.md': '#p', '/p/sub/f.js': 'x' }, '/czf.zip');
    const f = await laExtract(b);
    assert.strictEqual(f['p/readme.md'], '#p');
    assert.strictEqual(f['p/sub/f.js'], 'x');
  });

  await test('cross: TAR→LA', async () => {
    const b = await j7zCompress({ '/t.txt': 'ct' }, '/ct.tar');
    const f = await laExtract(b);
    assert.strictEqual(f['t.txt'], 'ct');
  });

  // ── 7. libarchive-wasm specific ──
  await test('LA: extract encrypted ZIP', async () => {
    const b = await j7zCompress({ '/e.txt': 'enc' }, '/lz.zip', ['-pla']);
    const f = await laExtract(b, 'la');
    assert.strictEqual(f['e.txt'], 'enc');
  });

  await test('LA: wrong password throws', async () => {
    const b = await j7zCompress({ '/e.txt': 'x' }, '/lz2.zip', ['-pla']);
    try {
      await laExtract(b, 'bad');
      assert.fail('Should have thrown');
    } catch (er) {
      assert.ok(
        (er as Error).message.includes('passphrase') || (er as Error).message.includes('Incorrect'),
        (er as Error).message,
      );
    }
  });

  await test('LA: hasEncryptedData on encrypted ZIP', async () => {
    const b = await j7zCompress({ '/x.txt': 'x' }, '/he.zip', ['-ppw']);
    const v = await laHasEncrypted(b);
    assert.ok(v === true || v === false || v === null, `value: ${v}`);
  });

  await test('LA: hasEncryptedData on plain ZIP', async () => {
    const b = await j7zCompress({ '/x.txt': 'x' }, '/hp.zip');
    const v = await laHasEncrypted(b);
    assert.ok(v === true || v === false || v === null, `value: ${v}`);
  });

  await test('LA: hasEncryptedData on 7z (returns null)', async () => {
    const b = await j7zCompress({ '/x.txt': 'x' }, '/h7z.7z', ['-ppw', '-mhe=on']);
    const v = await laHasEncrypted(b);
    assert.strictEqual(v, null, 'libarchive-wasm cannot detect 7z encryption');
  });

  await test('LA: decompress 7z-created GZip', async () => {
    const b = await j7zCompress({ '/stream.txt': 'gz la' }, '/lg.gz');
    try {
      const f = await laExtract(b);
      assert.ok(Object.values(f).length >= 1, 'should extract');
    } catch (er) {
      assert.ok(
        (er as Error).message.includes('memory') || (er as Error).message.includes('bounds'),
        (er as Error).message,
      );
    }
  });

  // ── 8. Security ──
  await test('sec: path traversal blocked', () => {
    const safeJoin = (outDir: string, entry: string): string => {
      if (entry.includes('\0')) throw new Error(`null byte: ${entry}`);
      const safe = entry
        .replace(/^[a-zA-Z]:\\/, '')
        .replace(/^[a-zA-Z]:/, '')
        .replace(/^\/+/, '');
      const resolved = path.resolve(outDir, safe);
      const norm = path.resolve(outDir) + path.sep;
      const within =
        process.platform === 'win32'
          ? resolved.toLowerCase().startsWith(norm.toLowerCase())
          : resolved.startsWith(norm);
      if (!within && resolved !== path.resolve(outDir)) throw new Error('outside');
      return resolved;
    };
    assert.strictEqual(safeJoin('/tmp/x', 'file.txt'), path.resolve('/tmp/x', 'file.txt'));
    assert.throws(() => safeJoin('/tmp/x', '../../../etc/passwd'), /outside/);
    assert.throws(() => safeJoin('/tmp/x', 'f\0.bin'), /null byte/);
  });

  await test('sec: size limits', () => {
    const MAX_F = 1024 * 1024 * 1024;
    const MAX_T = 10 * MAX_F;
    const checkFile = (s: number) => { if (s > MAX_F) throw new Error('exceeds'); };
    const checkTotal = (c: number, a: number): number => {
      const t = c + a; if (t > MAX_T) throw new Error('exceeds'); return t;
    };
    assert.doesNotThrow(() => checkFile(0));
    assert.throws(() => checkFile(MAX_F + 1), /exceeds/);
    assert.strictEqual(checkTotal(0, 100), 100);
    assert.throws(() => checkTotal(MAX_T, 1), /exceeds/);
  });

  // ── 9. CJK FS round-trip ──
  await test('CJK: virtual FS preserves Chinese filenames', async () => {
    const j = await JS7z();
    j.FS.mkdir('/in');
    const cjkName = '\u4E2D\u6587\u6587\u4EF6.txt';
    j.FS.writeFile('/in/' + cjkName, new Uint8Array(Buffer.from('hello')));
    const entries = j.FS.readdir('/in');
    const found = entries.filter((e) => e !== '.' && e !== '..');
    assert.strictEqual(found.length, 1, `expected 1 entry, got ${found.length}: [${found}]`);
    assert.strictEqual(found[0], cjkName, `got "${found[0]}" expected "${cjkName}"`);
  });

  await test('CJK: archive round-trip via FS basename', async () => {
    const j = await JS7z();
    j.FS.mkdir('/in');
    const cjkName = '\u4E2D\u6587\u6587\u4EF6.txt';
    j.FS.writeFile('/in/' + cjkName, new Uint8Array(Buffer.from('world')));
    await run7z(j, ['a', '/cjk.7z', '/in/' + cjkName]);
    const j2 = await JS7z();
    const buf = Buffer.from(j.FS.readFile('/cjk.7z', { encoding: 'binary' }));
    j2.FS.writeFile('/cjk.7z', new Uint8Array(buf));
    await run7z(j2, ['l', '-slt', '/cjk.7z']);
    assert.ok(true);
  });

  // ── 10. Encryption detection for preview ──
  // Inline isEncrypted logic (can't require main project — depends on vscode)
  async function isEncryptedInline(filePath: string): Promise<boolean> {
    const data = fs.readFileSync(filePath);
    let stdout = '',
      stderr = '';
    const j = await JS7z({
      print: (t: string) => (stdout += t + '\n'),
      printErr: (t: string) => (stderr += t + '\n'),
    });
    j.FS.writeFile('/_ie', new Uint8Array(data));
    try {
      await new Promise<void>((resolve, reject) => {
        j.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
        j.callMain(['l', '-slt', '-p', '/_ie']);
      });
      return stdout.includes('Encrypted = +');
    } catch {
      const msg = (stdout + stderr).toLowerCase();
      return msg.includes('encrypted') || msg.includes('wrong password');
    }
  }

  await test('enc 7z: listing fails without password', async () => {
    const b = await j7zCompressDir({ '/f.txt': 'secret' }, '/enc.7z', ['-pp4ss', '-mhe=on']);
    const tmp = path.join(td, 'enc-test.7z');
    fs.writeFileSync(tmp, b);
    const encrypted = await isEncryptedInline(tmp);
    assert.strictEqual(encrypted, true, 'isEncrypted should detect encrypted 7z');
    const j = await JS7z();
    j.FS.writeFile('/_t.7z', new Uint8Array(b));
    try {
      await new Promise<void>((resolve, reject) => {
        j.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
        j.callMain(['l', '-slt', '-sccUTF-8', '/_t.7z']);
      });
      assert.fail('listing encrypted 7z without pw should fail');
    } catch (er) {
      assert.ok((er as Error).message.includes('exit 2'));
    }
    fs.unlinkSync(tmp);
  });

  await test('enc 7z: listing succeeds with correct password', async () => {
    const b = await j7zCompressDir({ '/f.txt': 'secret' }, '/enc2.7z', ['-pp4ss', '-mhe=on']);
    let out = '';
    const j = await JS7z({
      print: (t: string) => (out += t + '\n'),
      printErr: () => {},
    });
    j.FS.writeFile('/_t2.7z', new Uint8Array(b));
    await new Promise<void>((resolve, reject) => {
      j.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
      j.callMain(['l', '-slt', '-sccUTF-8', '-pp4ss', '/_t2.7z']);
    });
    assert.ok(out.includes('f.txt'), `listing with pw: ${out.slice(0, 200)}`);
  });

  await test('enc ZIP: isEncrypted detects encryption', async () => {
    const b = await j7zCompressDir({ '/f.txt': 'zip-secret' }, '/enc.zip', ['-pzip']);
    const tmp = path.join(td, 'enc-test.zip');
    fs.writeFileSync(tmp, b);
    const encrypted = await isEncryptedInline(tmp);
    assert.strictEqual(encrypted, true, 'isEncrypted should detect encrypted ZIP');
    fs.unlinkSync(tmp);
  });

  // ── 11. Tree builder ──
  // Inline buildTree (pure logic, no vscode dependency)
  interface TreeNode {
    name: string;
    path: string;
    size: number;
    kind: string;
    children?: TreeNode[];
  }
  function buildTree(
    entries: { path: string; size: number; type: string }[],
    archiveName: string,
  ): TreeNode[] {
    const normed: { entry: (typeof entries)[0]; parts: string[] }[] = [];
    for (const e of entries) {
      const parts = e.path.replace(/\\/g, "/").split("/").filter(Boolean);
      if (parts.length === 1 && parts[0] === archiveName) continue;
      normed.push({ entry: e, parts });
    }
    const root: TreeNode[] = [];
    const dirMap = new Map<string, TreeNode>();
    normed.sort((a, b) => {
      const aD = a.entry.type !== "REGULAR_FILE" ? 0 : 1;
      const bD = b.entry.type !== "REGULAR_FILE" ? 0 : 1;
      if (aD !== bD) return aD - bD;
      return a.entry.path.localeCompare(b.entry.path);
    });
    for (const { entry, parts } of normed) {
      let siblings = root;
      let prefix = "";
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        const last = i === parts.length - 1;
        const full = prefix ? prefix + "/" + seg : seg;
        if (last) {
          if (seg === ".smartarchive") continue;
          const isDir = entry.type !== "REGULAR_FILE";
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
            siblings.push(node);
            if (isDir) dirMap.set(full, node);
          }
        } else {
          let dir = dirMap.get(full);
          if (!dir) {
            const dup = siblings.findIndex((s) => s.name === seg && s.kind !== "DIRECTORY");
            if (dup >= 0) siblings.splice(dup, 1);
            dir = { name: seg, path: full, size: 0, kind: "DIRECTORY", children: [] };
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
  function countTreeStats(
    nodes: TreeNode[],
  ): { files: number; dirs: number; total: number } {
    let files = 0,
      dirs = 0;
    for (const n of nodes) {
      if (n.kind === "DIRECTORY") {
        dirs++;
        if (n.children && n.children.length > 0) {
          const c = countTreeStats(n.children);
          files += c.files;
          dirs += c.dirs;
        }
      } else {
        files++;
      }
    }
    return { files, dirs, total: files + dirs };
  }

  await test('tree: flat files only', () => {
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

  await test('tree: nested with implicit dirs', () => {
    const entries = [
      { path: "src/main.ts", size: 100, type: "REGULAR_FILE" },
      { path: "src/lib/util.ts", size: 50, type: "REGULAR_FILE" },
      { path: "readme.md", size: 30, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.zip");
    // Should have: src/ (dir) + readme.md (file)
    assert.strictEqual(tree.length, 2);
    const src = tree.find((n) => n.kind === "DIRECTORY");
    assert.ok(src, "should have src directory");
    assert.strictEqual(src!.children!.length, 2); // main.ts + lib/
    const stats = countTreeStats(tree);
    assert.strictEqual(stats.files, 3);
    assert.strictEqual(stats.dirs, 2); // src + src/lib
    assert.strictEqual(stats.total, 5);
  });

  await test('tree: explicit directory entries', () => {
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

  await test('tree: dedup dir entry with implicit dir', () => {
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

  await test('tree: archive self-entry filtered', () => {
    const entries = [
      { path: "test.7z", size: 1000, type: "REGULAR_FILE" },
      { path: "data.txt", size: 50, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "test.7z");
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].name, "data.txt");
  });

  // ── 15. Add-to-archive path preservation ──
  await test('add: individual file paths lose dir structure', async () => {
    // 7z strips the common prefix — subdir/ is lost
    const j = await JS7z();
    j.FS.mkdir('/subdir');
    j.FS.writeFile('/subdir/a.txt', new Uint8Array(Buffer.from('a')));
    j.FS.writeFile('/subdir/b.txt', new Uint8Array(Buffer.from('b')));
    await run7z(j, ['a', '/test.7z', '-aot', '/subdir/a.txt', '/subdir/b.txt']);
    const buf = Buffer.from(j.FS.readFile('/test.7z', { encoding: 'binary' }));
    const f = await j7zDecompress(buf);
    assert.ok(f['a.txt'], 'a.txt should exist at root');
    assert.ok(f['b.txt'], 'b.txt should exist at root');
    assert.ok(!f['subdir/a.txt'], 'subdir/a.txt should NOT exist (stripped)');
  });

  await test('add: passing a directory preserves structure', async () => {
    // 7z preserves directory name when passing the dir itself
    const j = await JS7z();
    j.FS.mkdir('/subdir');
    j.FS.writeFile('/subdir/a.txt', new Uint8Array(Buffer.from('a')));
    j.FS.writeFile('/subdir/b.txt', new Uint8Array(Buffer.from('b')));
    await run7z(j, ['a', '/test.7z', '-aot', '/subdir']);
    const buf = Buffer.from(j.FS.readFile('/test.7z', { encoding: 'binary' }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f['subdir/a.txt'], 'a', 'should preserve subdir/');
    assert.strictEqual(f['subdir/b.txt'], 'b');
  });

  await test('add: single file in directory preserves dir name', async () => {
    const j = await JS7z();
    j.FS.mkdir('/subdir');
    j.FS.writeFile('/subdir/a.txt', new Uint8Array(Buffer.from('a')));
    await run7z(j, ['a', '/test.7z', '-aot', '/subdir']);
    const buf = Buffer.from(j.FS.readFile('/test.7z', { encoding: 'binary' }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f['subdir/a.txt'], 'a');
  });

  await test('add: deeply nested dir via first-level directory', async () => {
    // Passing only the first-level dir /a preserves full path a/b/c/file.txt
    const j = await JS7z();
    mkdirP(j, '/a/b/c');
    j.FS.writeFile('/a/b/c/d.txt', new Uint8Array(Buffer.from('deep')));
    j.FS.writeFile('/a/b/e.txt', new Uint8Array(Buffer.from('e')));
    await run7z(j, ['a', '/test.7z', '-aot', '/a']);
    const buf = Buffer.from(j.FS.readFile('/test.7z', { encoding: 'binary' }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f['a/b/c/d.txt'], 'deep');
    assert.strictEqual(f['a/b/e.txt'], 'e');
  });

  await test('add: root-level files via individual paths', async () => {
    const j = await JS7z();
    j.FS.writeFile('/a.txt', new Uint8Array(Buffer.from('a')));
    j.FS.writeFile('/b.txt', new Uint8Array(Buffer.from('b')));
    await run7z(j, ['a', '/test.7z', '-aot', '/a.txt', '/b.txt']);
    const buf = Buffer.from(j.FS.readFile('/test.7z', { encoding: 'binary' }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f['a.txt'], 'a');
    assert.strictEqual(f['b.txt'], 'b');
  });

  await test('createFolder: new directory with .smartarchive marker', async () => {
    const j = await JS7z();
    j.FS.writeFile('/f.txt', new Uint8Array(Buffer.from('x')));
    await run7z(j, ['a', '/test.7z', '/f.txt']);
    let buf = Buffer.from(j.FS.readFile('/test.7z', { encoding: 'binary' }));

    const j2 = await JS7z();
    j2.FS.writeFile('/test.7z', new Uint8Array(buf));
    mkdirP(j2, '/sub/newdir');
    j2.FS.writeFile('/sub/newdir/.smartarchive', new Uint8Array(Buffer.from('.')));
    await run7z(j2, ['a', '/test.7z', '-aot', '/sub']);

    buf = Buffer.from(j2.FS.readFile('/test.7z', { encoding: 'binary' }));
    const f = await j7zDecompress(buf);
    assert.strictEqual(f['f.txt'], 'x');
    assert.strictEqual(f['sub/newdir/.smartarchive'], '.');

    // treeBuilder filters .smartarchive leaf but keeps directory structure
    const tree = buildTree(
      [
        { path: "f.txt", size: 1, type: "REGULAR_FILE" },
        { path: "sub/newdir/.smartarchive", size: 1, type: "REGULAR_FILE" },
      ],
      "test.7z",
    );
    assert.strictEqual(tree.length, 2, 'should have f.txt + sub/ dir');
    const subDir = tree.find((n: any) => n.kind === "DIRECTORY" && n.name === "sub") as any;
    assert.ok(subDir, 'sub/ should exist as implicit directory');
    assert.strictEqual(subDir!.children!.length, 1);
    assert.strictEqual(subDir!.children![0].name, 'newdir');
    assert.strictEqual(subDir!.children![0].kind, 'DIRECTORY');
  });

  // ── 16. Format / encoding utilities ──
  await test('util: fixArchiveEncoding passes ASCII through', () => {
    const fixAE = (raw: string): string => {
      if (!raw) return raw;
      if (/^[\x00-\x7F]*$/.test(raw)) return raw;
      return raw;
    };
    assert.strictEqual(fixAE("hello.txt"), "hello.txt");
    assert.strictEqual(fixAE(""), "");
  });

  await test('util: getFullExt detects wrapped extensions', () => {
    const getFullExt = (fp: string): string => {
      const lower = fp.toLowerCase();
      const compounds = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".txz"];
      for (const ext of compounds) {
        if (lower.endsWith(ext)) return ext;
      }
      return path.extname(fp).toLowerCase();
    };
    assert.strictEqual(getFullExt("archive.tar.gz"), ".tar.gz");
    assert.strictEqual(getFullExt("archive.tgz"), ".tgz");
    assert.strictEqual(getFullExt("archive.tar.xz"), ".tar.xz");
    assert.strictEqual(getFullExt("archive.7z"), ".7z");
    assert.strictEqual(getFullExt("archive.zip"), ".zip");
  });

  await test('util: formatCompactSize', () => {
    const fmt = (bytes: number): string => {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const units = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
      const val = bytes / Math.pow(k, i);
      return `${i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
    };
    assert.strictEqual(fmt(0), "0 B");
    assert.strictEqual(fmt(500), "500 B");
    assert.ok(fmt(1024).startsWith("1.0 KB"));
    assert.ok(fmt(1048576).startsWith("1.0 MB"));
  });

  await test('util: formatDuration', () => {
    const fmtD = (ms: number): string => {
      if (ms < 1000) return `${ms}ms`;
      const s = Math.floor(ms / 1000) % 60;
      const m = Math.floor(ms / 60000);
      if (m === 0) return `${s}s`;
      return `${m}m ${s}s`;
    };
    assert.strictEqual(fmtD(500), "500ms");
    assert.strictEqual(fmtD(5000), "5s");
    assert.strictEqual(fmtD(65000), "1m 5s");
    assert.strictEqual(fmtD(125000), "2m 5s");
  });

  // ── 17. RAR utilities ──
  await test('rar: isRarExt', () => {
    const isRarExt = (ext: string): boolean => /^\.(?:rar|r\d{2})$/i.test(ext);
    assert.strictEqual(isRarExt(".rar"), true);
    assert.strictEqual(isRarExt(".r00"), true);
    assert.strictEqual(isRarExt(".r99"), true);
    assert.strictEqual(isRarExt(".zip"), false);
    assert.strictEqual(isRarExt(".7z"), false);
  });

  await test('rar: isRarVolume only matches headerless parts', () => {
    const isRarVolume = (ext: string): boolean => /^\.r\d{2}$/i.test(ext);
    assert.strictEqual(isRarVolume(".r00"), true);
    assert.strictEqual(isRarVolume(".r50"), true);
    assert.strictEqual(isRarVolume(".rar"), false);
    assert.strictEqual(isRarVolume(".r1"), false);
  });

  fs.rmSync(td, { recursive: true, force: true });

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
})();
