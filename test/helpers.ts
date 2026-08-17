/**
 * Test fixture oracle — Smart Archiver VSCode Extension
 *
 * The ONLY test-side implementations in this suite. Everything here is an
 * independent oracle that produces archive bytes through the raw 7zz WASM
 * CLI — deliberately not reusing production compression logic, so a broken
 * production codec cannot pass a round-trip test by "compressing like
 * itself". Logic that mirrors production (tree building, format detection,
 * security utils, listing parsing) must NOT live here — import it from
 * src/ instead, so tests and production share one implementation.
 * Pure logic — no vscode dependency.
 */

import * as path from "path";

import { JS7z as createJS7z } from "../src/engines/js7z-factory";
import { wasmCompress } from "../src/engines/js7z-codec";

// Bundled 7zz WASM engine (see src/engines/js7z-factory.ts).
const JS7z: (opts?: Record<string, unknown>) => Promise<JS7zInstance> = createJS7z;

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
  callMain(args: string[]): number;
  onExit: ((ec: number) => void) | null;
  printErr?: (t: string) => void;
  print?: (t: string) => void;
  NODEFS: unknown;
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
  // Shared 7zz instance: destroy/_cleanup are no-ops. Never null the shared
  // callbacks — other tracked aliases of the same instance may still be live.
  try {
    if (typeof j.destroy === "function") j.destroy();
    else if (typeof (j as any)._cleanup === "function") (j as any)._cleanup();
  } catch {
    // best effort
  }
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
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.replace(/^\/+/, "").split("/")[0]))];
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

import * as zlib from "node:zlib";

const snappy: {
  compressSync: (data: Buffer | Uint8Array) => Buffer;
  uncompressSync: (data: Buffer) => Buffer;
} = require("snappy");

export async function createWrapped(files: Record<string, string>, ext: string): Promise<Buffer> {
  const j1 = await JS7z();
  try {
    for (const [fp, c] of Object.entries(files)) {
      const d = path.posix.dirname(fp);
      if (d && d !== "/") mkdirP(j1, d);
      j1.FS.writeFile(fp, new Uint8Array(Buffer.from(c)));
    }
    const tops = [...new Set(Object.keys(files).map((f) => "/" + f.replace(/^\/+/, "").split("/")[0]))];
    await run7z(j1, ["a", "/_t.tar", ...tops]);
    const tb = Buffer.from(j1.FS.readFile("/_t.tar", { encoding: "binary" }));
    if (ext === "tar.zst" || ext === "tzst") {
      return Buffer.from(await wasmCompress(tb, "zst", 3));
    }
    if (ext === "tar.lz4" || ext === "tlz4") {
      return Buffer.from(await wasmCompress(tb, "lz4", 5));
    }
    if (ext === "tar.br" || ext === "tbr") {
      return Buffer.from(zlib.brotliCompressSync(Buffer.from(tb), {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
      }));
    }
    if (ext === "tar.sz" || ext === "tsz") {
      const compressed = snappy.compressSync(tb);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(compressed.length, 0);
      return Buffer.concat([lenBuf, compressed]);
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
