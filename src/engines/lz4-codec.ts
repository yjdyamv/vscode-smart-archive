/**
 * LZ4 codec wrapper — Smart Archive VSCode Extension
 *
 * Compression/decompression prefer the bundled native 7zz (standard LZ4
 * frame format, single-threaded), falling back to the bundled 7zz WASM
 * engine. The WASM engine decodes standard LZ4 frames, including
 * concatenated frames.
 *
 * @module engines/lz4-codec
 */

import type { ProgressLike } from "../utils/cancellation";
import {
  shouldUseWasmCodec,
  wasmCompress,
  wasmCompressFile,
  wasmDecompress,
  wasmDecompressFile,
} from "./js7z-codec";
import {
  nativeCompress,
  nativeCompressFile,
  nativeDecompress,
  nativeDecompressFile,
} from "./native-codec";

/**
 * LZ4 levels barely change size (the fork maps -mx to LZ4 HC 1–12, where
 * only speed varies). Always use the fast preset so tar.lz4 compression
 * stays fast; the UI level is intentionally ignored for lz4.
 */
const LZ4_FAST_LEVEL = 1;

export async function lz4CompressFile(
  input: string,
  output: string,
  _level: number,
  progress?: ProgressLike,
): Promise<void> {
  if (
    !shouldUseWasmCodec() &&
    (await nativeCompressFile(input, output, "lz4", LZ4_FAST_LEVEL, progress))
  ) {
    return;
  }
  await wasmCompressFile(input, output, "lz4", LZ4_FAST_LEVEL, progress);
}

export async function lz4Compress(data: Uint8Array, _level?: number): Promise<Uint8Array> {
  if (!shouldUseWasmCodec()) {
    const nativeOut = await nativeCompress(data, "lz4", LZ4_FAST_LEVEL);
    if (nativeOut) return nativeOut;
  }
  return wasmCompress(data, "lz4", LZ4_FAST_LEVEL);
}

export async function lz4Decompress(data: Uint8Array): Promise<Uint8Array> {
  if (!shouldUseWasmCodec()) {
    const nativeOut = await nativeDecompress(data, "lz4");
    if (nativeOut) return nativeOut;
  }
  return wasmDecompress(data, "lz4");
}

export async function lz4DecompressFile(input: string, output: string): Promise<void> {
  if (!shouldUseWasmCodec() && (await nativeDecompressFile(input, output, "lz4"))) {
    return;
  }
  await wasmDecompressFile(input, output, "lz4");
}
