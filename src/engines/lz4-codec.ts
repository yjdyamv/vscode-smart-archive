/**
 * LZ4 codec wrapper — Smart Archive VSCode Extension
 *
 * Both compression and decompression go through the bundled 7zz WASM
 * engine. Compression uses the standard LZ4 frame format
 * (single-threaded); decompression uses the same WASM engine and decodes
 * standard LZ4 frames, including concatenated frames.
 *
 * @module engines/lz4-codec
 */

import type { ProgressLike } from "../utils/cancellation";
import { wasmCompress, wasmCompressFile, wasmDecompress, wasmDecompressFile } from "./js7z-codec";

export async function lz4CompressFile(
  input: string,
  output: string,
  _level: number,
  progress?: ProgressLike,
): Promise<void> {
  await wasmCompressFile(input, output, "lz4", _level, progress);
}

export async function lz4Compress(data: Uint8Array, _level?: number): Promise<Uint8Array> {
  return wasmCompress(data, "lz4", _level ?? 5);
}

export async function lz4Decompress(data: Uint8Array): Promise<Uint8Array> {
  return wasmDecompress(data, "lz4");
}

export async function decompressLz4Frames(compressed: Buffer): Promise<Uint8Array> {
  return wasmDecompress(compressed, "lz4");
}

export async function lz4DecompressFile(input: string, output: string): Promise<void> {
  await wasmDecompressFile(input, output, "lz4");
}
