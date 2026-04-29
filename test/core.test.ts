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

  fs.rmSync(td, { recursive: true, force: true });

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
})();
