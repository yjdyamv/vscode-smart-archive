/**
 * Shared test setup — Smart Archive VSCode Extension
 *
 * Code shared across test files that test against js7z-tools WASM engine.
 * Imports: vitest globals, path/fs/os, helpers, codec modules, inline security
 * re-implementations (avoiding vscode dependency).
 */

import * as path from "path";

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

export const zstd = require("zstd-napi") as {
  compress: (data: Buffer, opts?: { compressionLevel?: number }) => Buffer;
  decompress: (data: Buffer) => Buffer;
};

export const lz4 = require("lz4-napi") as {
  compressFrame: (data: Uint8Array) => Promise<Buffer>;
  decompressFrame: (data: Uint8Array) => Promise<Buffer>;
};

// brotli: migrated to node:zlib; in-memory helper uses brotli-codec engine
import { brotliDecompress } from "../src/engines/brotli-codec";

export function decompressBrotliFrames(data: Buffer): Uint8Array {
  return brotliDecompress(new Uint8Array(data));
}

export const snappy = require("snappy") as {
  compressSync: (data: Buffer | Uint8Array) => Buffer;
  uncompressSync: (data: Buffer) => Buffer;
};

export function decompressSnappyFrames(data: Buffer): Uint8Array {
  const frameLen = data.readUInt32LE(0);
  return snappy.uncompressSync(data.subarray(4, 4 + frameLen));
}

export async function decompressLz4Frames(data: Buffer): Promise<Uint8Array> {
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
    parts.push(await lz4.decompressFrame(frame));
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
