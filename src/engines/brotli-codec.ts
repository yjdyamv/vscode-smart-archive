/**
 * Brotli codec wrapper — Smart Archive VSCode Extension
 *
 * Uses node:zlib for brotli compression/decompression.
 * 7z WASM does not support brotli, so we handle both compression
 * and decompression entirely through Node.js native brotli bindings,
 * feeding only the inner .tar to 7z for extraction/listing.
 *
 * @module engines/brotli-codec
 */

import { logger } from "../utils/logger-core";
import { checkFileSize, checkTotalSize } from "../utils/security";
import type { ProgressLike } from "../utils/cancellation";
import * as zlib from "node:zlib";
import * as fs from "fs";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CODEC_CHUNK } from "../constants";

// ── Level mapping ──

function mapBrotliLevel(uiLevel: number): number {
  if (uiLevel <= 0) return 0;
  if (uiLevel <= 1) return 1;
  if (uiLevel <= 3) return 4;
  if (uiLevel <= 5) return 6;
  if (uiLevel <= 7) return 9;
  return 11;
}

function makeCompressParams(level: number): zlib.BrotliOptions {
  return {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: mapBrotliLevel(level),
    },
  };
}

// ── In-memory compression / decompression ──

interface BrotliDecompressInfoResult {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

export function brotliCompress(data: Uint8Array, level = 5): Uint8Array {
  const params = makeCompressParams(level);
  return zlib.brotliCompressSync(Buffer.from(data), params);
}

export function brotliDecompress(data: Uint8Array): Uint8Array {
  checkFileSize(data.byteLength);
  const buf = Buffer.from(data);

  const frames: Buffer[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const result = zlib.brotliDecompressSync(buf.subarray(offset), {
      info: true,
    }) as unknown as BrotliDecompressInfoResult;

    const consumed = result.engine.bytesWritten;
    if (consumed <= 0) {
      throw new Error("Brotli decompression stalled at offset " + offset);
    }

    checkFileSize(result.buffer.length);
    frames.push(result.buffer);
    offset += consumed;
  }

  if (frames.length === 1) return new Uint8Array(frames[0]);

  const total = frames.reduce((s, f) => s + f.length, 0);
  checkFileSize(total);
  const merged = Buffer.concat(frames);
  return new Uint8Array(merged);
}

// ── File-to-file streaming compression / decompression ──

export async function brotliCompressFile(
  input: string,
  output: string,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  const params = makeCompressParams(level);
  const total = fs.statSync(input).size;
  try {
    if (progress && total > 0) {
      const counter = new PassThrough();
      let bytes = 0;
      let lastPct = 0;
      counter.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        const pct = Math.min(99, Math.floor((bytes / total) * 100));
        if (pct > lastPct && pct > 0) {
          progress.report({ message: `${pct}%`, increment: pct - lastPct });
          lastPct = pct;
        }
      });
      await pipeline(
        fs.createReadStream(input, { highWaterMark: CODEC_CHUNK }),
        counter,
        zlib.createBrotliCompress(params),
        fs.createWriteStream(output),
      );
    } else {
      await pipeline(
        fs.createReadStream(input, { highWaterMark: CODEC_CHUNK }),
        zlib.createBrotliCompress(params),
        fs.createWriteStream(output),
      );
    }
    logger.info({ event: "brotli.compress.ok", input, output, level });
  } catch (err) {
    cleanup(output);
    throw err;
  }
}

export async function brotliDecompressFile(input: string, output: string): Promise<void> {
  let streamDecompressed = 0;

  try {
    const decompress = zlib.createBrotliDecompress();

    decompress.on("data", (chunk: Buffer) => {
      streamDecompressed = checkTotalSize(streamDecompressed, chunk.length);
    });

    await pipeline(
      fs.createReadStream(input, { highWaterMark: CODEC_CHUNK }),
      decompress,
      fs.createWriteStream(output),
    );

    // The streaming decompression produces at least the first brotli frame.
    // Verify completeness against a full in-memory decompression. Guard
    // against OOM by only doing this for compressed files under 200 MB.
    const MAX_IN_MEMORY = 200 * 1024 * 1024;
    const inputStat = fs.statSync(input);

    if (inputStat.size > 0 && inputStat.size <= MAX_IN_MEMORY) {
      try {
        const compressedBuf = fs.readFileSync(input);
        const fullOutput = brotliDecompress(compressedBuf);

        if (fullOutput.length > streamDecompressed) {
          // Multi-frame detected — overwrite with complete output
          fs.writeFileSync(output, Buffer.from(fullOutput));
          streamDecompressed = fullOutput.length;
          logger.info({
            event: "brotli.decompress.multiFrameFallback",
            input,
            size: fullOutput.length,
          });
        }
      } catch (verifyErr) {
        // Full verification failed (corrupt data / OOM). The streaming
        // output already written is valid best-effort — keep it.
        logger.warn(
          { event: "brotli.decompress.verifyFallbackFailed", input, error: String(verifyErr) },
          "Multi-frame verification failed, keeping streaming output",
        );
      }
    }

    logger.info({ event: "brotli.decompress.ok", input, output });
  } catch (err) {
    cleanup(output);
    throw err;
  }
}

// ── Helpers ──

function cleanup(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    logger.warn({ event: "brotli.cleanup.failed", path }, "Failed to remove temp file");
  }
}
