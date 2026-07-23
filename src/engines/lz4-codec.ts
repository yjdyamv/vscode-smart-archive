/**
 * LZ4 codec wrapper — Smart Archive VSCode Extension
 *
 * Uses @addmaple/lz4 (Rust + WASM, lz4_flex FrameEncoder) for
 * LZ4 frame-format compression. Decompression is handled by
 * js7z-tools (7z v24.01+ supports LZ4).
 *
 * LZ4 is a single-speed algorithm — the level parameter is ignored.
 * Chunked file compression produces concatenated LZ4 frames (standard).
 *
 * @module engines/lz4-codec
 */

import { logger } from "../utils/logger";
import { checkFileSize, checkTotalSize } from "../utils/security";
import * as fs from "fs";
import { CODEC_CHUNK } from "../constants";

const lz4 = require("@addmaple/lz4") as {
  init: () => Promise<void>;
  compress: (data: Uint8Array, options?: { level?: number }) => Promise<Uint8Array>;
};

let _lz4js: { decompress: (data: Uint8Array) => Uint8Array } | null = null;

function getLz4js(): { decompress: (data: Uint8Array) => Uint8Array } {
  if (!_lz4js) {
    _lz4js = require("lz4js") as { decompress: (data: Uint8Array) => Uint8Array };
  }
  return _lz4js;
}

let initP: Promise<void> | null = null;
let initFailed = false;

function ensureInit(): Promise<void> {
  if (initFailed) {
    return Promise.reject(
      new Error("LZ4 WASM initialization previously failed — restart may be required"),
    );
  }
  if (!initP) {
    initP = lz4.init().catch((err) => {
      logger.error({ event: "lz4.init.failed", err }, "LZ4 initialization failed");
      initFailed = true;
      initP = null;
      throw err;
    });
  }
  return initP;
}

export async function lz4CompressFile(
  input: string,
  output: string,
  _level: number,
): Promise<void> {
  await ensureInit();

  const CHUNK = CODEC_CHUNK;
  const rfd = fs.openSync(input, "r");
  const out = fs.openSync(output, "w");
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    while (true) {
      const n = fs.readSync(rfd, buf, 0, buf.length, pos);
      if (n === 0) break;
      const frame = await lz4.compress(new Uint8Array(buf.slice(0, n)));
      fs.writeSync(out, Buffer.from(frame));
      pos += n;
    }
    logger.info({ event: "lz4.compress.wasm.ok", input, output });
  } finally {
    fs.closeSync(rfd);
    fs.closeSync(out);
  }
}

export async function lz4Compress(data: Uint8Array, _level?: number): Promise<Uint8Array> {
  await ensureInit();
  return lz4.compress(data);
}

export function lz4Decompress(data: Uint8Array): Uint8Array {
  checkFileSize(data.byteLength);
  const compressed = Buffer.from(data);
  const lz4js = getLz4js();
  const LZ4_MAGIC_BUF = Buffer.from([0x04, 0x22, 0x4d, 0x18]);
  const parts: Uint8Array[] = [];
  let offset = 0;
  let totalSize = 0;
  while (offset < compressed.length) {
    const magicIdx = compressed.indexOf(LZ4_MAGIC_BUF, offset);
    if (magicIdx < 0) break;
    offset = magicIdx;
    const nextMagic = compressed.indexOf(LZ4_MAGIC_BUF, offset + 4);
    const end = nextMagic < 0 ? compressed.length : nextMagic;
    const frame = compressed.subarray(offset, end);
    const decompressed = lz4js.decompress(frame);
    totalSize = checkTotalSize(totalSize, decompressed.length);
    checkFileSize(decompressed.length);
    parts.push(decompressed);
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

export async function lz4DecompressFile(input: string, output: string): Promise<void> {
  const rfd = fs.openSync(input, "r");
  const wfd = fs.openSync(output, "w");
  try {
    const compressed = Buffer.alloc(fs.fstatSync(rfd).size);
    fs.readSync(rfd, compressed, 0, compressed.length, 0);

    const lz4js = getLz4js();
    const LZ4_MAGIC_BUF = Buffer.from([0x04, 0x22, 0x4d, 0x18]);
    let offset = 0;
    let totalSize = 0;
    while (offset < compressed.length) {
      const magicIdx = compressed.indexOf(LZ4_MAGIC_BUF, offset);
      if (magicIdx < 0) break;
      offset = magicIdx;
      const nextMagic = compressed.indexOf(LZ4_MAGIC_BUF, offset + 4);
      const end = nextMagic < 0 ? compressed.length : nextMagic;
      const frame = compressed.subarray(offset, end);
      const decompressed = lz4js.decompress(frame);
      totalSize = checkTotalSize(totalSize, decompressed.length);
      checkFileSize(decompressed.length);
      fs.writeSync(wfd, Buffer.from(decompressed));
      offset = end;
    }
    logger.info({ event: "lz4.decompress.ok", input, output });
  } finally {
    try {
      fs.closeSync(rfd);
    } catch {
      logger.warn({ event: "lz4.decompress.closeFailed" }, "Failed to close file descriptor");
    }
    try {
      fs.closeSync(wfd);
    } catch {
      logger.warn({ event: "lz4.decompress.closeFailed" }, "Failed to close file descriptor");
    }
  }
}
