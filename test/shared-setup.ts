/**
 * Shared test setup — Smart Archiver VSCode Extension
 *
 * Code shared across test files that test against the bundled 7zz WASM engine.
 * Imports: vitest globals, path/fs/os, fixture oracle (./helpers), codec
 * modules, and PRODUCTION logic modules — tests must exercise production
 * implementations, never copies.
 */


// ── Fixture oracle (test-side implementation, intentionally independent) ──

export {
  mkdirP,
  run7z,
  j7zCompress,
  j7zCompressDir,
  j7zDecompress,
  copyFS,
  createWrapped,
  disposeJS7z,
  trackedJS7z,
  resetActiveInstances,
  disposeAllTracked,
  getActiveInstances,
} from "./helpers";

export type { JS7zInstance } from "./helpers";

export { testCompress, testDecompress } from "./test-helpers";

// ── Production logic under test (one implementation, no mirrors) ──

export {
  buildTreeRootOnly,
  getDirChildren,
} from "../src/providers/treeBuilder";
export type { TreeNode, FlatEntry } from "../src/providers/treeBuilder";

export { fixArchiveEncoding } from "../src/utils/path";
export { getFullExt } from "../src/constants";
export { formatCompactSize, formatDuration } from "../src/utils/format";
export { isRarExt, isRarVolume } from "../src/utils/rar";
export { isEncryptedWasm } from "../src/engines/js7z-list-core";
export {
  parseSize,
  safeJoinPath,
  checkArchiveSize,
  checkTotalSize,
  OversizeArchiveError,
  isOversizeError,
  validatePassword,
  sanitizeCliPath,
  sanitizeTargetDir,
} from "../src/utils/security";

// ── Codec modules (WASM-based; no native addons anymore) ──

import { wasmCompress, wasmDecompress } from "../src/engines/js7z-codec";

export const zstd = {
  compress: async (
    data: Uint8Array,
    opts?: { compressionLevel?: number },
  ): Promise<Buffer> =>
    Buffer.from(await wasmCompress(data, "zst", opts?.compressionLevel ?? 3)),
  decompress: async (data: Uint8Array): Promise<Buffer> =>
    Buffer.from(await wasmDecompress(data, "zst")),
};

export const lz4 = {
  compressFrame: async (data: Uint8Array): Promise<Buffer> =>
    Buffer.from(await wasmCompress(data, "lz4", 5)),
  decompressFrame: async (data: Uint8Array): Promise<Buffer> =>
    Buffer.from(await wasmDecompress(data, "lz4")),
};

// brotli: migrated to node:zlib; in-memory helper uses brotli-codec engine
import { brotliDecompress } from "../src/engines/brotli-codec";

export async function decompressBrotliFrames(data: Buffer): Promise<Uint8Array> {
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

// ── Exclusion module (production) ──

export const { prepareExclusions, isPathExcluded, isTargetExcluded } = await import(
  "../src/utils/exclude"
);
