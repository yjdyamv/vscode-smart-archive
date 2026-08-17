import { logger } from "../utils/logger-core";
import { checkTotalSize } from "../utils/security";
import type { ProgressLike } from "../utils/cancellation";
import * as fs from "fs";
import * as path from "path";
import { CODEC_CHUNK } from "../constants";
import { isMusl } from "../utils/platform";

const OPTS = { copyOutputData: true };

export type SnappyBackend = "auto" | "native" | "wasm";

interface SnappyLike {
  compress: (data: Buffer | Uint8Array, opts?: { copyOutputData?: boolean }) => Promise<Buffer>;
  compressSync: (data: Buffer | Uint8Array, opts?: { copyOutputData?: boolean }) => Buffer;
  uncompress: (data: Buffer, opts?: { copyOutputData?: boolean }) => Promise<Buffer>;
  uncompressSync: (data: Buffer, opts?: { copyOutputData?: boolean }) => Buffer;
}

/** Injected config: snappyBackend setting (wired by utils/config.ts + worker). */
let snappyConfig: { backend?: SnappyBackend } = {};

/**
 * Inject the snappyBackend setting. The host/worker wire it from
 * `smart-archiver.snappyBackend`; tests inject it directly.
 */
export function setSnappyConfig(config: { backend?: SnappyBackend }): void {
  snappyConfig = config;
}

/**
 * Resolve the active backend. NAPI_RS_FORCE_WASI (used by CI/tests) takes
 * precedence over the setting so forced-WASM runs stay reproducible.
 */
export function resolveSnappyBackend(): SnappyBackend {
  const force = process.env.NAPI_RS_FORCE_WASI;
  if (force === "error" || force === "true" || force === "1") return "wasm";
  const backend = snappyConfig.backend ?? "auto";
  return backend === "native" || backend === "wasm" ? backend : "auto";
}

let nativeSnappy: SnappyLike | undefined;
let wasmSnappy: SnappyLike | undefined;
let nativeSnappyError: Error | undefined;
let wasmSnappyError: Error | undefined;

/** Drop cached bindings/errors (e.g. after a setting change or re-stage). */
export function resetSnappyBindingCache(): void {
  nativeSnappy = undefined;
  wasmSnappy = undefined;
  nativeSnappyError = undefined;
  wasmSnappyError = undefined;
}

function loadNativeSnappy(): SnappyLike {
  if (nativeSnappy) return nativeSnappy;
  if (nativeSnappyError) throw nativeSnappyError;
  // Snappy's napi-rs loader has a broken isMusl(): when glibcVersionRuntime is
  // absent (Electron/VM environments) it assumes musl with no fallback, causing
  // it to load linux-x64-musl.node on glibc systems. We patch getReport() to
  // inject glibcVersionRuntime when we know the system is glibc.
  const _getReport = process.report?.getReport;
  if (process.platform === "linux" && typeof _getReport === "function" && !isMusl()) {
    process.report.getReport = function () {
      const r = _getReport.call(process.report) as Record<string, unknown> | undefined;
      const header = r && typeof r === "object" ? (r as Record<string, unknown>).header : undefined;
      if (
        header &&
        typeof header === "object" &&
        (header as Record<string, unknown>).glibcVersionRuntime
      )
        return r as object;
      return { header: { glibcVersionRuntime: process.versions?.node ?? "unknown" } };
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeSnappy = require("snappy") as SnappyLike;
    return nativeSnappy;
  } catch (err) {
    nativeSnappyError = err instanceof Error ? err : new Error(String(err));
    throw nativeSnappyError;
  } finally {
    if (process.platform === "linux" && typeof _getReport === "function") {
      process.report.getReport = _getReport;
    }
  }
}

function loadWasmSnappy(): SnappyLike {
  if (wasmSnappy) return wasmSnappy;
  if (wasmSnappyError) throw wasmSnappyError;
  try {
    // The staged WASI loader sits next to the natives (installed by
    // scripts/install-snappy-platforms.js); requiring it directly bypasses
    // the upstream index.js native-first logic. Resolve through the package
    // main's directory: snappy 7.3+ restricts "exports", so the subpath
    // "snappy/snappy.wasi.cjs" is not importable directly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wasiLoader = path.join(path.dirname(require.resolve("snappy")), "snappy.wasi.cjs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    wasmSnappy = require(wasiLoader) as SnappyLike;
    return wasmSnappy;
  } catch (err) {
    wasmSnappyError = err instanceof Error ? err : new Error(String(err));
    throw wasmSnappyError;
  }
}

function resolveSnappy(): SnappyLike {
  const backend = resolveSnappyBackend();
  const errors: Error[] = [];
  if (backend === "wasm") {
    try {
      return loadWasmSnappy();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  } else if (backend === "native") {
    try {
      return loadNativeSnappy();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  } else {
    try {
      return loadNativeSnappy();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
    try {
      return loadWasmSnappy();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  throw new Error(
    `snappy engine unavailable (backend "${backend}"): ` + errors.map((e) => e.message).join(" | "),
  );
}

export async function snappyCompressFile(
  input: string,
  output: string,
  _level: number,
  progress?: ProgressLike,
): Promise<void> {
  const CHUNK = CODEC_CHUNK;
  const snappy = resolveSnappy();
  const rfd = fs.openSync(input, "r");
  const out = fs.openSync(output, "w");
  const total = fs.fstatSync(rfd).size;
  let lastPct = 0;
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    while (true) {
      const n = fs.readSync(rfd, buf, 0, buf.length, pos);
      if (n === 0) break;
      const frame = snappy.compressSync(new Uint8Array(buf.slice(0, n)), OPTS);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(frame.length, 0);
      fs.writeSync(out, lenBuf);
      fs.writeSync(out, frame);
      pos += n;
      if (progress && total > 0) {
        const pct = Math.min(99, Math.floor((pos / total) * 100));
        if (pct > lastPct && pct > 0) {
          progress.report({ message: `${pct}%`, increment: pct - lastPct });
          lastPct = pct;
        }
      }
    }
    logger.info({ event: "snappy.compress.ok", input, output });
  } finally {
    fs.closeSync(rfd);
    fs.closeSync(out);
  }
}

export async function snappyCompress(data: Uint8Array, _level?: number): Promise<Uint8Array> {
  // Use the sync API: the upstream WASI loader's async path relies on emnapi
  // async-work workers that are not wired up, while compressSync is fully
  // supported by both the native addon and the WASM engine. Codec calls run
  // inside the archive worker thread, so blocking briefly is acceptable.
  const compressed = resolveSnappy().compressSync(data, OPTS);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(compressed.length, 0);
  return Buffer.concat([lenBuf, compressed]);
}

export async function snappyDecompress(data: Uint8Array): Promise<Uint8Array> {
  const buf = Buffer.from(data);
  const parts: Uint8Array[] = [];
  let offset = 0;
  let totalSize = 0;

  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const frameLen = buf.readUInt32LE(offset);
    offset += 4;
    if (frameLen === 0) break;
    if (offset + frameLen > buf.length) break;
    const frame = buf.subarray(offset, offset + frameLen);
    offset += frameLen;
    const decompressed = resolveSnappy().uncompressSync(frame, OPTS);
    totalSize = checkTotalSize(totalSize, decompressed.length);
    parts.push(decompressed);
  }

  if (parts.length === 0) throw new Error("No snappy frames found");

  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

export async function snappyDecompressFile(input: string, output: string): Promise<void> {
  const snappy = resolveSnappy();
  const rfd = fs.openSync(input, "r");
  const wfd = fs.openSync(output, "w");
  try {
    const totalSize = fs.fstatSync(rfd).size;
    let offset = 0;
    let writtenTotal = 0;

    while (offset < totalSize) {
      const header = Buffer.alloc(4);
      const headerBytes = fs.readSync(rfd, header, 0, 4, offset);
      if (headerBytes < 4) break;
      const frameLen = header.readUInt32LE(0);
      offset += 4;

      if (frameLen === 0) break;
      const frame = Buffer.alloc(frameLen);
      const frameBytes = fs.readSync(rfd, frame, 0, frameLen, offset);
      if (frameBytes < frameLen) {
        throw new Error("Truncated snappy frame");
      }
      offset += frameLen;

      const decompressed = snappy.uncompressSync(frame, OPTS);
      writtenTotal = checkTotalSize(writtenTotal, decompressed.length);
      fs.writeSync(wfd, decompressed);
    }

    logger.info({ event: "snappy.decompress.ok", input, output });
  } finally {
    try {
      fs.closeSync(rfd);
    } catch {
      logger.warn({ event: "snappy.decompress.closeFailed" }, "Failed to close file descriptor");
    }
    try {
      fs.closeSync(wfd);
    } catch {
      logger.warn({ event: "snappy.decompress.closeFailed" }, "Failed to close file descriptor");
    }
  }
}
