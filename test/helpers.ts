/**
 * Test helpers — Smart Archive VSCode Extension
 *
 * Shared VFS utilities, compression/decompression wrappers, tree builders,
 * and format utilities used by extension test files.
 * Pure logic — no vscode dependency.
 */

import * as path from "path";

// js7z-tools is a CommonJS module
const JS7z: (opts?: Record<string, unknown>) => Promise<JS7zInstance> = require("js7z-tools");

// Track all WASM instances created in each test so they can be
// cleaned up in afterEach, preventing vitest worker OOM crashes.
let _activeInstances: JS7zInstance[] = [];

export function getActiveInstances(): JS7zInstance[] {
  return _activeInstances;
}

export function resetActiveInstances(): void {
  _activeInstances = [];
}

export async function trackedJS7z(
  opts?: Record<string, unknown>,
): Promise<JS7zInstance> {
  const instance = await JS7z(opts);
  _activeInstances.push(instance);
  return instance;
}

export function disposeAllTracked(): void {
  for (const j of _activeInstances) {
    disposeJS7z(j);
  }
  _activeInstances = [];
}

// ── Types ──

export interface JS7zInstance {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, data: Uint8Array): void;
    readFile(p: string, opts?: { encoding: "binary" }): ArrayBuffer;
    readdir(p: string): string[];
    stat(p: string): { mode: number; size: number };
    isDir(mode: number): boolean;
    mount(type: unknown, opts: { root: string }, mountPoint: string): void;
    createDataFile(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean, canOwn?: number): void;
    open(path: string, flags: string): unknown;
    write(stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number): void;
    close(stream: unknown): void;
  };
  callMain(args: string[]): void;
  onExit: ((ec: number) => void) | null;
  printErr?: (t: string) => void;
  print?: (t: string) => void;
  NODEFS: unknown;
}

export interface TreeNode {
  name: string;
  path: string;
  size: number;
  kind: string;
  children?: TreeNode[];
  collapsed?: boolean;
}

export interface FlatEntry {
  path: string;
  size: number;
  type: string;
}

// ── VFS helpers ──

export function mkdirP(j: JS7zInstance, p: string): void {
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

export function run7z(j: JS7zInstance, args: string[]): Promise<void> {
  let err = "";
  j.print = () => {};
  j.printErr = (t: string) => {
    err += t + "\n";
  };
  return new Promise((resolve, reject) => {
    j.onExit = (ec: number) => {
      j.onExit = null;
      j.print = undefined;
      j.printErr = undefined;
      if (ec === 0) resolve();
      else reject(new Error(`7z exit ${ec}\n${err}`));
    };
    j.callMain(args);
  });
}

export function disposeJS7z(j: JS7zInstance): void {
  // Release WASM memory — same logic as the production disposeJS7z
  try {
    if (typeof j.destroy === "function") j.destroy();
    else if (typeof (j as any)._cleanup === "function") (j as any)._cleanup();
  } catch {
    // best effort
  }
  // Null callbacks to prevent stale handlers from firing
  j.onExit = null;
  j.print = undefined;
  j.printErr = undefined;
}

export async function j7zCompress(
  files: Record<string, string>,
  archive: string,
  extra: string[] = [],
): Promise<Buffer> {
  const j = await JS7z();
  try {
    for (const [fp, content] of Object.entries(files)) {
      const dir = path.posix.dirname(fp);
      if (dir && dir !== "/") mkdirP(j, dir);
      j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
    }
    await run7z(j, ["a", archive, ...Object.keys(files), ...extra]);
    return Buffer.from(j.FS.readFile(archive, { encoding: "binary" }));
  } finally {
    disposeJS7z(j);
  }
}

export async function j7zCompressDir(
  files: Record<string, string>,
  archive: string,
  extra: string[] = [],
): Promise<Buffer> {
  const j = await JS7z();
  try {
    for (const [fp, content] of Object.entries(files)) {
      const dir = path.posix.dirname(fp);
      if (dir && dir !== "/") mkdirP(j, dir);
      j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
    }
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[1]))];
    await run7z(j, ["a", archive, ...tops, ...extra]);
    return Buffer.from(j.FS.readFile(archive, { encoding: "binary" }));
  } finally {
    disposeJS7z(j);
  }
}

export function copyFS(j: JS7zInstance, dir: string, prefix: string, res: Record<string, string>): void {
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

export async function j7zSelective(
  buf: Buffer,
  paths: string[],
  pw = "",
): Promise<Record<string, string>> {
  const j = await JS7z();
  try {
    j.FS.writeFile("/a", new Uint8Array(buf));
    j.FS.mkdir("/o");
    const args = ["x", "/a", "-o/o"];
    if (pw) { args.splice(1, 0, "-p" + pw); } else { args.splice(1, 0, "-p-"); }
    args.push(...paths);
    const res: Record<string, string> = {};
    await run7z(j, args);
    copyFS(j, "/o", "", res);
    return res;
  } finally {
    disposeJS7z(j);
  }
}

export async function j7zDecompress(buf: Buffer, pw = ""): Promise<Record<string, string>> {
  const j = await JS7z();
  try {
    j.FS.writeFile("/a", new Uint8Array(buf));
    j.FS.mkdir("/o");
    const args = ["x", "/a", "-o/o"];
    if (pw) { args.splice(1, 0, "-p" + pw); } else { args.splice(1, 0, "-p-"); }
    const res: Record<string, string> = {};
    await run7z(j, args);
    copyFS(j, "/o", "", res);
    return res;
  } finally {
    disposeJS7z(j);
  }
}

// ── Wrapped archive helpers ──

const zstd: {
  compress: (data: Buffer, opts?: { compressionLevel?: number }) => Buffer;
  decompress: (data: Buffer) => Buffer;
} = require("zstd-napi");

const lz4: {
  compressFrame: (data: Uint8Array) => Promise<Buffer>;
  decompressFrame: (data: Uint8Array) => Promise<Buffer>;
} = require("lz4-napi");

const brWasm: {
  compress: (data: Uint8Array, options?: { quality?: number }) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
} = require("brotli-wasm");

export async function createWrapped(files: Record<string, string>, ext: string): Promise<Buffer> {
  const j1 = await JS7z();
  try {
    for (const [fp, c] of Object.entries(files)) {
      const d = path.posix.dirname(fp);
      if (d && d !== "/") mkdirP(j1, d);
      j1.FS.writeFile(fp, new Uint8Array(Buffer.from(c)));
    }
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[1]))];
    await run7z(j1, ["a", "/_t.tar", ...tops]);
    const tb = Buffer.from(j1.FS.readFile("/_t.tar", { encoding: "binary" }));
    if (ext === "tar.zst" || ext === "tzst") {
      return zstd.compress(tb, { compressionLevel: 3 });
    }
    if (ext === "tar.lz4" || ext === "tlz4") {
      return Buffer.from(await lz4.compressFrame(new Uint8Array(tb)));
    }
    if (ext === "tar.br" || ext === "tbr") {
      return Buffer.from(brWasm.compress(new Uint8Array(tb), { quality: 6 }));
    }
    const j2 = await JS7z();
    try {
      j2.FS.writeFile("/_t.tar", new Uint8Array(tb));
      await run7z(j2, ["a", "/_w." + ext, "/_t.tar"]);
      return Buffer.from(j2.FS.readFile("/_w." + ext, { encoding: "binary" }));
    } finally {
      disposeJS7z(j2);
    }
  } finally {
    disposeJS7z(j1);
  }
}

export function walkFS(j: JS7zInstance, dir: string, prefix: string): string[] {
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

// ── Tree builder (production-mirror) ──

export function buildTree(entries: FlatEntry[], archiveName: string): TreeNode[] {
  const normed: { entry: FlatEntry; parts: string[] }[] = [];
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

export function countTreeStats(nodes: TreeNode[]): { files: number; dirs: number; total: number } {
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

import * as fs from "fs";

export async function isEncryptedInline(filePath: string): Promise<boolean> {
  const data = fs.readFileSync(filePath);
  let stdout = "",
    stderr = "";
  const j = await JS7z({
    print: (t: string) => (stdout += t + "\n"),
    printErr: (t: string) => (stderr += t + "\n"),
  });
  try {
    j.FS.writeFile("/_ie", new Uint8Array(data));
    try {
      await new Promise<void>((resolve, reject) => {
        j.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
        j.callMain(["l", "-slt", "-p-", "/_ie"]);
      });
      return stdout.includes("Encrypted = +");
    } catch {
      const msg = (stdout + stderr).toLowerCase();
      return msg.includes("encrypted") || msg.includes("wrong password");
    }
  } finally {
    disposeJS7z(j);
  }
}

// ── Format / encoding utilities (mirrors src/) ──

export function fixArchiveEncoding(raw: string): string {
  if (!raw) return raw;
  if (/^[ -~]*$/.test(raw)) return raw;
  return raw;
}

export function getFullExt(fp: string): string {
  const lower = fp.toLowerCase();
  const compounds = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".txz"];
  for (const ext of compounds) {
    if (lower.endsWith(ext)) return ext;
  }
  return path.extname(fp).toLowerCase();
}

export function formatCompactSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const val = bytes / Math.pow(k, i);
  return `${i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export function isRarExt(ext: string): boolean {
  return /^\.(?:rar|r\d{2})$/i.test(ext);
}

export function isRarVolume(ext: string): boolean {
  return /^\.r\d{2}$/i.test(ext);
}
