/**
 * Shared test setup — Smart Archive VSCode Extension
 *
 * Code shared across test files that test against js7z-tools WASM engine.
 * Imports: vitest globals, path/fs/os, helpers, codec modules, inline security
 * re-implementations (avoiding vscode dependency).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export {
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
  disposeJS7z,
  trackedJS7z,
  resetActiveInstances,
  disposeAllTracked,
} from "./helpers";

export { testCompress, testDecompress } from "./test-helpers";

export type { JS7zInstance, FlatEntry } from "./helpers";

// ── Codec modules (lazy init) ──

export const zstd: {
  init: () => Promise<void>;
  compress: (data: Uint8Array, level?: number) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
} = require("@bokuweb/zstd-wasm");

export const lz4Wasm: {
  init: () => Promise<void>;
  compress: (data: Uint8Array, options?: { level?: number }) => Promise<Uint8Array>;
} = require("@addmaple/lz4");
export let lz4Inited = false;
export function setLz4Inited(v: boolean): void {
  lz4Inited = v;
}

export const { decompress: lz4jsDec } = require("lz4js") as {
  decompress: (data: Uint8Array) => Uint8Array;
};

export const brWasm: {
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

// ── Decompression helpers ──

export function decompressBrotliFrames(data: Buffer): Uint8Array {
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

export function decompressLz4Frames(data: Buffer): Uint8Array {
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

// ── Inline security utils (avoid vscode dependency) ──

export function sanitizeCliPath(entryName: string): string {
  return entryName.startsWith("-") ? "./" + entryName : entryName;
}

export function sanitizeTargetDir(dir: string): string {
  if (!dir) return "";
  let safe = dir.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = safe.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") throw new Error("path traversal");
  }
  return safe;
}

export function safeJoin(outDir: string, entry: string): string {
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

export function parseSize(raw: string | number | undefined, def: number): number {
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

// ── Exclusion module ──

export const { prepareExclusions, isPathExcluded, isTargetExcluded } = await import(
  "../src/utils/exclude"
);
