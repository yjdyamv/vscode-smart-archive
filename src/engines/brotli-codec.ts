/**
 * Brotli codec wrapper — Smart Archive VSCode Extension
 *
 * Uses brotli-wasm for brotli compression/decompression.
 * 7z WASM does not support brotli, so we handle both compression
 * and decompression entirely in WASM, feeding only the inner .tar
 * to 7z for extraction/listing.
 *
 * Chunked file compression produces concatenated brotli streams
 * (RFC 7932 Section 3.3). Per-frame DecompressStream is used for
 * decompression since brotli-wasm's single-shot decompress only
 * handles one stream.
 *
 * @module engines/brotli-codec
 */

import { logger } from "../utils/logger";
import { checkFileSize } from "../utils/security";
import * as fs from "fs";

const brotli = require("brotli-wasm") as {
  compress: (data: Uint8Array, options?: { quality?: number }) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
  CompressStream: new (quality?: number) => {
    compress: (
      input: Uint8Array,
      outputSize?: number,
    ) => {
      code: number;
      buf: Uint8Array;
      input_offset: number;
    };
    free: () => void;
  };
  DecompressStream: new () => {
    decompress: (
      input: Uint8Array,
      outputSize?: number,
    ) => {
      code: number;
      buf: Uint8Array;
      input_offset: number;
    };
    free: () => void;
  };
};

/**
 * Map VSCode 0-9 compression level to brotli's 0-11 range.
 * Brotli's quality 4 is roughly equivalent to zstd level 3.
 */
function mapBrotliLevel(uiLevel: number): number {
  if (uiLevel <= 0) return 0;
  if (uiLevel <= 1) return 1;
  if (uiLevel <= 3) return 4;
  if (uiLevel <= 5) return 6;
  if (uiLevel <= 7) return 9;
  return 11;
}

export function brotliCompress(data: Uint8Array, level = 5): Uint8Array {
  return brotli.compress(data, { quality: mapBrotliLevel(level) });
}

export function brotliDecompress(data: Uint8Array): Uint8Array {
  checkFileSize(data.byteLength);
  let allOut: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) {
    const stream = new brotli.DecompressStream();
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
  checkFileSize(total);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of allOut) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

export function brotliCompressFile(input: string, output: string, level: number): Promise<void> {
  return Promise.resolve().then(() => {
    const CHUNK = 50 * 1024 * 1024;
    const rfd = fs.openSync(input, "r");
    const out = fs.openSync(output, "w");
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      const quality = mapBrotliLevel(level);
      while (true) {
        const n = fs.readSync(rfd, buf, 0, buf.length, pos);
        if (n === 0) break;
        const frame = brotli.compress(new Uint8Array(buf.subarray(0, n)), { quality });
        fs.writeSync(out, Buffer.from(frame));
        pos += n;
      }
      logger.info({ event: "brotli.compress.ok", input, output, level });
    } catch (err) {
      cleanup(output);
      throw err;
    } finally {
      try {
        fs.closeSync(rfd);
      } catch {}
      try {
        fs.closeSync(out);
      } catch {}
    }
  });
}

export async function brotliDecompressFile(input: string, output: string): Promise<void> {
  const READ_CHUNK = 4 * 1024 * 1024;
  const OUT_HINT = 50 * 1024 * 1024;

  const rfd = fs.openSync(input, "r");
  const wfd = fs.openSync(output, "w");
  try {
    let stream = new brotli.DecompressStream();
    let pending = Buffer.alloc(0);
    const readBuf = Buffer.alloc(READ_CHUNK);
    let filePos = 0;

    while (true) {
      const n = fs.readSync(rfd, readBuf, 0, READ_CHUNK, filePos);
      if (n === 0) break;
      filePos += n;

      let data =
        pending.length > 0
          ? Buffer.concat([pending, readBuf.subarray(0, n)])
          : readBuf.subarray(0, n);
      pending = Buffer.alloc(0);
      let off = 0;

      while (off < data.length) {
        const r = stream.decompress(new Uint8Array(data.subarray(off)), OUT_HINT);
        if (r.buf.length > 0) {
          fs.writeSync(wfd, Buffer.from(r.buf));
        }

        if (r.input_offset > 0) {
          off += r.input_offset;
          continue;
        }

        // input_offset === 0: stream stopped consuming
        if (off >= data.length) {
          // No more data available — save pending for next read
          pending = data.subarray(off);
          break;
        }

        // Data remains but stream won't consume it → frame boundary
        stream.free();
        stream = new brotli.DecompressStream();
        // Continue loop with remaining data (don't advance off)
        // The next iteration will try to consume from `off`
      }
    }

    if (stream) {
      // Flush remaining output
      const flushR = stream.decompress(new Uint8Array(0), OUT_HINT);
      if (flushR.buf.length > 0) {
        fs.writeSync(wfd, Buffer.from(flushR.buf));
      }
      stream.free();
    }

    logger.info({ event: "brotli.decompress.ok", input, output });
  } catch (err) {
    cleanup(output);
    throw err;
  } finally {
    try {
      fs.closeSync(rfd);
    } catch {}
    try {
      fs.closeSync(wfd);
    } catch {}
  }
}

function cleanup(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    /* ignore */
  }
}
