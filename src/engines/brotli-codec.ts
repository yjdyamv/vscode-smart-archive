/**
 * Brotli codec wrapper — Smart Archiver VSCode Extension
 *
 * Backend is configurable via `smart-archiver.brotliBackend`:
 * - auto (default): best native implementation (Node.js zlib)
 * - native: Node.js built-in zlib
 * - bundled: bundled native 7-Zip binary, falling back to node:zlib when
 *   the binary is missing or the run fails
 * - wasm: bundled 7zz WASM engine
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
import {
  nativeCompress,
  nativeCompressFile,
  nativeDecompress,
  nativeDecompressFile,
} from "./native-codec";

type BrotliBackend = "auto" | "native" | "bundled" | "wasm";

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
  const backend = brotliConfig.backend ?? "auto";
  if (backend === "wasm" || backend === "bundled" || backend === "native") {
    return backend;
  }
  return "auto";
}

/** Warn once the native 7z path could not be used for brotli. */
function warn7zUnavailable(): void {
  brotliConfig.warn?.(t("brotli.7zUnavailable"));
}

/** auto and native both resolve to node:zlib (the best native tier). */
function usesNodeZlib(backend: BrotliBackend): boolean {
  return backend === "auto" || backend === "native";
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
  const backend = resolveBrotliBackend();
  if (backend === "bundled") {
    const nativeOut = await nativeCompress(data, "br", level);
    if (nativeOut) return nativeOut;
    warn7zUnavailable();
    return zlib.brotliCompressSync(Buffer.from(data), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level },
    });
  }
  if (usesNodeZlib(backend)) {
    return zlib.brotliCompressSync(Buffer.from(data), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level },
    });
  }
  return wasmCompress(data, "br", level);
}

export async function brotliDecompress(data: Uint8Array): Promise<Uint8Array> {
  const backend = resolveBrotliBackend();
  if (backend === "bundled") {
    const nativeOut = await nativeDecompress(data, "br");
    if (nativeOut) return nativeOut;
    warn7zUnavailable();
    return zlib.brotliDecompressSync(Buffer.from(data));
  }
  if (usesNodeZlib(backend)) {
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
  const backend = resolveBrotliBackend();
  if (backend === "bundled") {
    if (await nativeCompressFile(input, output, "br", level, progress)) return;
    warn7zUnavailable();
    await nodeCompressFile(input, output, level, progress);
    return;
  }
  if (usesNodeZlib(backend)) {
    await nodeCompressFile(input, output, level, progress);
    return;
  }
  await wasmCompressFile(input, output, "br", level, progress);
}

export async function brotliDecompressFile(input: string, output: string): Promise<void> {
  const backend = resolveBrotliBackend();
  if (backend === "bundled") {
    if (await nativeDecompressFile(input, output, "br")) return;
    warn7zUnavailable();
    await nodeDecompressFile(input, output);
    return;
  }
  if (usesNodeZlib(backend)) {
    await nodeDecompressFile(input, output);
    return;
  }
  await wasmDecompressFile(input, output, "br");
}
