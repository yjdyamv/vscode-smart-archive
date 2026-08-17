/**
 * 7zz-wasm codec helpers — Smart Archiver VSCode Extension
 *
 * Single-file stream codecs (zstd / brotli / lz4) backed by the bundled
 * 7-Zip ZS WASM engine. The engine creates and extracts these formats
 * natively, so codec wrappers can fall back to it when system/native
 * codec paths are unavailable.
 *
 * File-level helpers stream through the VFS and reuse run7z, so progress
 * and the worker memory guard behave exactly like the other WASM archive
 * operations. Buffer-level helpers go through temporary files so they can
 * reuse the file helpers. Note that every JS7z() call resets the shared
 * VFS, so callers must not keep live VFS state across a codec call
 * (modify-core creates its scratch directory only after the codec call).
 *
 * @module engines/js7z-codec
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ProgressLike } from "../utils/cancellation";
import { logger } from "../utils/logger-core";
import { JS7z } from "./js7z-factory";
import { createPrintBridge, disposeJS7z, INPUT_DIR, OUTPUT_DIR, run7z } from "./js7z-helpers";
import { streamToVFS } from "./vfs-io";
import { joinFSPath } from "../utils/path";

export type WasmCodec = "zst" | "br" | "lz4";

/** Test-only switch: force codec wrappers onto the WASM engine. */
let forceWasm = false;

export function setForceWasmCodec(enabled: boolean): void {
  forceWasm = enabled;
}

/** Whether codec operations should skip native paths and use WASM directly. */
export function shouldUseWasmCodec(): boolean {
  return forceWasm || process.env.SA_FORCE_WASM_CODEC === "1";
}

const INPUT_NAME = "input.bin";
const OUTPUT_BASE = "archive";

/**
 * Compress a local file into a single-codec stream (.zst/.br/.lz4) with
 * the 7zz WASM engine.
 */
export async function wasmCompressFile(
  input: string,
  output: string,
  codec: WasmCodec,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  const printBridge = createPrintBridge();
  const js7z = await JS7z({ print: printBridge.print, printErr: printBridge.printErr });
  try {
    js7z.FS.mkdir(INPUT_DIR);
    js7z.FS.mkdir(OUTPUT_DIR);
    const inPath = streamToVFS(js7z, input, joinFSPath(INPUT_DIR, INPUT_NAME));
    const outPath = joinFSPath(OUTPUT_DIR, `${OUTPUT_BASE}.${codec}`);
    // zstd has an official MT format, so it stays parallel (-mmt=on).
    // brotli/lz4 have no standard MT container, so they compress through
    // the single-threaded codec path (-mmt=off) for standard-compatible
    // output.
    const mtArg = codec === "zst" ? "-mmt=on" : "-mmt=off";
    await run7z(
      js7z,
      ["a", outPath, inPath, `-mx${level}`, mtArg],
      progress,
      undefined,
      undefined,
      printBridge,
    );
    const data = js7z.FS.readFile(outPath, { encoding: "binary" });
    fs.writeFileSync(output, Buffer.from(data));
    logger.info({ event: "wasmCodec.compress.ok", codec, input, output, level });
  } finally {
    disposeJS7z(js7z);
  }
}

/**
 * Decompress a single-codec stream (.zst/.br/.lz4) to a local file with
 * the 7zz WASM engine. 7-Zip writes one output file for these formats,
 * named after the archive; its name is irrelevant, so the helper reads
 * the sole entry of the output directory.
 */
export async function wasmDecompressFile(
  input: string,
  output: string,
  codec: WasmCodec,
  progress?: ProgressLike,
): Promise<void> {
  const printBridge = createPrintBridge();
  const js7z = await JS7z({ print: printBridge.print, printErr: printBridge.printErr });
  try {
    js7z.FS.mkdir(INPUT_DIR);
    js7z.FS.mkdir(OUTPUT_DIR);
    const inPath = streamToVFS(js7z, input, joinFSPath(INPUT_DIR, `${OUTPUT_BASE}.${codec}`));
    await run7z(
      js7z,
      // zstd decodes parallel (-mmt=on); brotli/lz4 have no standard MT
      // container and decode through the single-threaded path.
      ["x", inPath, `-o${OUTPUT_DIR}`, "-y", codec === "zst" ? "-mmt=on" : "-mmt=off"],
      progress,
      undefined,
      undefined,
      printBridge,
    );
    const entries = js7z.FS.readdir(OUTPUT_DIR).filter((e) => e !== "." && e !== "..");
    if (entries.length !== 1) {
      throw new Error(
        `Unexpected WASM ${codec} decompression output: ${entries.join(", ") || "(empty)"}`,
      );
    }
    const data = js7z.FS.readFile(`${OUTPUT_DIR}/${entries[0]}`, { encoding: "binary" });
    fs.writeFileSync(output, Buffer.from(data));
    logger.info({ event: "wasmCodec.decompress.ok", codec, input, output });
  } finally {
    disposeJS7z(js7z);
  }
}

/**
 * In-memory compression through temporary files, reusing the file helpers.
 */
export async function wasmCompress(
  data: Uint8Array,
  codec: WasmCodec,
  level: number,
): Promise<Uint8Array> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sawc_"));
  const input = path.join(tmpDir, INPUT_NAME);
  const output = path.join(tmpDir, `${OUTPUT_BASE}.${codec}`);
  try {
    fs.writeFileSync(input, Buffer.from(data));
    await wasmCompressFile(input, output, codec, level);
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * In-memory decompression through temporary files. Size guards mirror the
 * native codec wrappers so a decompression bomb is rejected before the
 * decompressed bytes reach the caller.
 */
export async function wasmDecompress(data: Uint8Array, codec: WasmCodec): Promise<Uint8Array> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sawd_"));
  const input = path.join(tmpDir, `${OUTPUT_BASE}.${codec}`);
  const output = path.join(tmpDir, "output.bin");
  try {
    fs.writeFileSync(input, Buffer.from(data));
    await wasmDecompressFile(input, output, codec);
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
