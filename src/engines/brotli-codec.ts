/**
 * Brotli codec wrapper — Smart Archive VSCode Extension
 *
 * Backend is configurable via `smart-archive.brotliBackend`:
 * - node (default): Node.js built-in zlib (native, no WASM heap)
 * - wasm: bundled 7zz WASM engine (standard single-stream brotli)
 * - 7z: bundled native 7-Zip binary (planned, not implemented yet)
 *
 * @module engines/brotli-codec
 */

import * as zlib from "node:zlib";
import * as fs from "fs";
import type { ProgressLike } from "../utils/cancellation";
import { t } from "../i18n";
import { DEFAULT_COMPRESSION_LEVEL } from "../constants";
import {
  shouldUseWasmCodec,
  wasmCompress,
  wasmCompressFile,
  wasmDecompress,
  wasmDecompressFile,
} from "./js7z-codec";

type BrotliBackend = "node" | "wasm" | "7z";

/** Injected config: brotliBackend setting + optional warning hook (host shows it). */
let brotliConfig: { backend?: string; warn?: (message: string) => void } = {};

/**
 * Inject the brotliBackend setting and a warning callback. The host wires
 * warn → vscode.window.showWarningMessage; worker threads receive the
 * setting at init and forward warnings as notify messages.
 */
export function setBrotliConfig(config: {
  backend?: string;
  warn?: (message: string) => void;
}): void {
  brotliConfig = config;
}

function resolveBrotliBackend(): BrotliBackend {
  if (shouldUseWasmCodec()) return "wasm";
  const backend = brotliConfig.backend ?? "node";
  if (backend === "wasm") return "wasm";
  if (backend === "7z") {
    // Bundled-7z brotli is planned but not implemented yet; stay usable
    // with node:zlib instead of failing the operation.
    brotliConfig.warn?.(t("brotli.7zUnavailable"));
    return "node";
  }
  return "node";
}

function nodeCompressFile(
  input: string,
  output: string,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let total = 0;
    try {
      total = fs.statSync(input).size;
    } catch {
      // Progress stays disabled when the input is unreadable; the stream
      // error path below still fails the operation.
    }
    const read = fs.createReadStream(input);
    const write = fs.createWriteStream(output);
    const comp = zlib.createBrotliCompress({
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level },
    });
    let processed = 0;
    let lastPct = 0;
    read.on("data", (chunk: Buffer) => {
      processed += chunk.length;
      if (progress && total > 0) {
        const pct = Math.min(99, Math.floor((processed / total) * 100));
        if (pct > lastPct) {
          progress.report({ message: `${pct}%`, increment: pct - lastPct });
          lastPct = pct;
        }
      }
    });
    const cleanup = () => {
      try {
        fs.unlinkSync(output);
      } catch {
        // best-effort cleanup
      }
    };
    read.on("error", (err) => {
      cleanup();
      reject(err);
    });
    comp.on("error", (err) => {
      cleanup();
      reject(err);
    });
    write.on("error", (err) => {
      cleanup();
      reject(err);
    });
    write.on("finish", () => {
      if (progress && total > 0 && lastPct < 100) {
        progress.report({ message: "100%", increment: 100 - lastPct });
      }
      resolve();
    });
    read.pipe(comp).pipe(write);
  });
}

function nodeDecompressFile(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(input);
    const write = fs.createWriteStream(output);
    const dec = zlib.createBrotliDecompress();
    const cleanup = () => {
      try {
        fs.unlinkSync(output);
      } catch {
        // best-effort cleanup
      }
    };
    read.on("error", (err) => {
      cleanup();
      reject(err);
    });
    dec.on("error", (err) => {
      cleanup();
      reject(err);
    });
    write.on("error", (err) => {
      cleanup();
      reject(err);
    });
    write.on("finish", () => resolve());
    read.pipe(dec).pipe(write);
  });
}

export async function brotliCompress(
  data: Uint8Array,
  level = DEFAULT_COMPRESSION_LEVEL,
): Promise<Uint8Array> {
  if (resolveBrotliBackend() === "node") {
    return zlib.brotliCompressSync(Buffer.from(data), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level },
    });
  }
  return wasmCompress(data, "br", level);
}

export async function brotliDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (resolveBrotliBackend() === "node") {
    const result = zlib.brotliDecompressSync(Buffer.from(data));
    return result;
  }
  const result = await wasmDecompress(data, "br");
  return result;
}

export async function brotliCompressFile(
  input: string,
  output: string,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  if (resolveBrotliBackend() === "node") {
    await nodeCompressFile(input, output, level, progress);
    return;
  }
  await wasmCompressFile(input, output, "br", level, progress);
}

export async function brotliDecompressFile(input: string, output: string): Promise<void> {
  if (resolveBrotliBackend() === "node") {
    await nodeDecompressFile(input, output);
    return;
  }
  await wasmDecompressFile(input, output, "br");
}
