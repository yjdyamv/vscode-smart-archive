import * as path from "path";
import * as fs from "fs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z = require("js7z-tools") as (opts?: Record<string, unknown>) => Promise<JS7zInstance>;

// ── Types ──

interface JS7zInstance {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, data: Uint8Array): void;
    readFile(p: string, opts?: { encoding: "binary" }): ArrayBuffer;
    readdir(p: string): string[];
    stat(p: string): { mode: number; size: number };
    isDir(mode: number): boolean;
    mount(type: unknown, opts: { root: string }, mountPoint: string): void;
  };
  callMain(args: string[]): void;
  onExit: ((ec: number) => void) | null;
  printErr?: (t: string) => void;
  print?: (t: string) => void;
  NODEFS: unknown;
}

interface TreeNode {
  name: string;
  path: string;
  size: number;
  kind: string;
  children?: TreeNode[];
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

// ── VFS helpers ──

function mkdirP(j: JS7zInstance, p: string): void {
  let cur = "";
  for (const part of p.split("/").filter(Boolean)) {
    cur += "/" + part;
    try {
      j.FS.mkdir(cur);
    } catch {
      /* already exists */
    }
  }
}

function run7z(j: JS7zInstance, args: string[]): Promise<void> {
  let err = "";
  j.printErr = (t: string) => {
    err += t + "\n";
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
    if (dir && dir !== "/") mkdirP(j, dir);
    j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
  }
  await run7z(j, ["a", archive, ...Object.keys(files), ...extra]);
  return Buffer.from(j.FS.readFile(archive, { encoding: "binary" }));
}

async function j7zCompressDir(
  files: Record<string, string>,
  archive: string,
  extra: string[] = [],
): Promise<Buffer> {
  const j = await JS7z();
  for (const [fp, content] of Object.entries(files)) {
    const dir = path.posix.dirname(fp);
    if (dir && dir !== "/") mkdirP(j, dir);
    j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
  }
  const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[1]))];
  await run7z(j, ["a", archive, ...tops, ...extra]);
  return Buffer.from(j.FS.readFile(archive, { encoding: "binary" }));
}

function copyFS(j: JS7zInstance, dir: string, prefix: string, res: Record<string, string>): void {
  for (const e of j.FS.readdir(dir)) {
    if (e === "." || e === "..") continue;
    const fp = path.posix.join(dir, e);
    const k = prefix ? prefix + "/" + e : e;
    try {
      const s = j.FS.stat(fp);
      if (j.FS.isDir(s.mode)) {
        copyFS(j, fp, k, res);
      } else {
        res[k] = Buffer.from(j.FS.readFile(fp, { encoding: "binary" })).toString();
      }
    } catch {
      try {
        res[k] = Buffer.from(j.FS.readFile(fp, { encoding: "binary" })).toString();
      } catch {
        /* skip */
      }
    }
  }
}

// ── Selective extraction helpers ──

async function j7zSelective(
  buf: Buffer,
  paths: string[],
  pw = "",
): Promise<Record<string, string>> {
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

async function j7zDecompress(buf: Buffer, pw = ""): Promise<Record<string, string>> {
  const j = await JS7z();
  j.FS.writeFile("/a", new Uint8Array(buf));
  j.FS.mkdir("/o");
  const args = ["x", "/a", "-o/o"];
  if (pw) args.splice(1, 0, "-p" + pw);
  const res: Record<string, string> = {};
  await run7z(j, args);
  copyFS(j, "/o", "", res);
  return res;
}

// ── Wrapped archive helpers ──

// eslint-disable-next-line @typescript-eslint/no-require-imports
const zstd = require("@bokuweb/zstd-wasm") as {
  init: () => Promise<void>;
  compress: (data: Uint8Array, level?: number) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
};
let zstdReady = false;

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
    if (!zstdReady) {
      await zstd.init();
      zstdReady = true;
    }
    return Buffer.from(zstd.compress(new Uint8Array(tb), 3));
  }
  const j2 = await JS7z();
  j2.FS.writeFile("/_t.tar", new Uint8Array(tb));
  await run7z(j2, ["a", "/_w." + ext, "/_t.tar"]);
  return Buffer.from(j2.FS.readFile("/_w." + ext, { encoding: "binary" }));
}

function walkFS(j: JS7zInstance, dir: string, prefix: string): string[] {
  const res: string[] = [];
  for (const name of j.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const fp = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const child = prefix ? `${prefix}/${name}` : name;
    try {
      const st = j.FS.stat(fp);
      if (j.FS.isDir(st.mode)) {
        res.push(child + "/");
        res.push(...walkFS(j, fp, child));
      } else {
        res.push(child);
      }
    } catch {
      res.push(child);
    }
  }
  return res;
}

// ── Tree builder (production logic for tests) ──

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
  let files = 0;
  let dirs = 0;
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

// ── Encryption detection ──

async function isEncryptedInline(filePath: string): Promise<boolean> {
  const data = fs.readFileSync(filePath);
  let stdout = "",
    stderr = "";
  const j = await JS7z({
    print: (t: string) => (stdout += t + "\n"),
    printErr: (t: string) => (stderr += t + "\n"),
  });
  j.FS.writeFile("/_ie", new Uint8Array(data));
  try {
    await new Promise<void>((resolve, reject) => {
      j.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
      j.callMain(["l", "-slt", "-p", "/_ie"]);
    });
    return stdout.includes("Encrypted = +");
  } catch {
    const msg = (stdout + stderr).toLowerCase();
    return msg.includes("encrypted") || msg.includes("wrong password");
  }
}

// ── Format / encoding utilities ──

function fixArchiveEncoding(raw: string): string {
  if (!raw) return raw;
  if (/^[\x00-\x7F]*$/.test(raw)) return raw;
  return raw;
}

function getFullExt(fp: string): string {
  const lower = fp.toLowerCase();
  const compounds = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".txz"];
  for (const ext of compounds) {
    if (lower.endsWith(ext)) return ext;
  }
  return path.extname(fp).toLowerCase();
}

function formatCompactSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const val = bytes / Math.pow(k, i);
  return `${i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function isRarExt(ext: string): boolean {
  return /^\.(?:rar|r\d{2})$/i.test(ext);
}

function isRarVolume(ext: string): boolean {
  return /^\.r\d{2}$/i.test(ext);
}

export type { JS7zInstance, TreeNode };
export {
  passed,
  failed,
  test,
  mkdirP,
  run7z,
  j7zCompress,
  j7zCompressDir,
  copyFS,
  j7zSelective,
  j7zDecompress,
  createWrapped,
  walkFS,
  buildTree,
  countTreeStats,
  isEncryptedInline,
  fixArchiveEncoding,
  getFullExt,
  formatCompactSize,
  formatDuration,
  isRarExt,
  isRarVolume,
};
