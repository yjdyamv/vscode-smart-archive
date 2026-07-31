import { logger } from "../utils/logger-core";
import { checkFileSize, checkTotalSize } from "../utils/security";
import * as fs from "fs";
import { CODEC_CHUNK } from "../constants";
import { isMusl } from "../utils/platform";

const OPTS = { copyOutputData: true };

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

const snappy = require("snappy") as {
  compress: (data: Buffer | Uint8Array, opts?: { copyOutputData?: boolean }) => Promise<Buffer>;
  compressSync: (data: Buffer | Uint8Array, opts?: { copyOutputData?: boolean }) => Buffer;
  uncompress: (data: Buffer, opts?: { copyOutputData?: boolean }) => Promise<Buffer>;
  uncompressSync: (data: Buffer, opts?: { copyOutputData?: boolean }) => Buffer;
};

if (process.platform === "linux" && typeof _getReport === "function") {
  process.report.getReport = _getReport;
}

export async function snappyCompressFile(
  input: string,
  output: string,
  _level: number,
): Promise<void> {
  const CHUNK = CODEC_CHUNK;
  const rfd = fs.openSync(input, "r");
  const out = fs.openSync(output, "w");
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
    }
    logger.info({ event: "snappy.compress.ok", input, output });
  } finally {
    fs.closeSync(rfd);
    fs.closeSync(out);
  }
}

export async function snappyCompress(data: Uint8Array, _level?: number): Promise<Uint8Array> {
  const compressed = await snappy.compress(data, OPTS);
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
    const decompressed = await snappy.uncompress(frame, OPTS);
    totalSize = checkTotalSize(totalSize, decompressed.length);
    checkFileSize(decompressed.length);
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

      const decompressed = await snappy.uncompress(frame, OPTS);
      writtenTotal = checkTotalSize(writtenTotal, decompressed.length);
      checkFileSize(decompressed.length);
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
