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
import * as fs from "fs";

const lz4 = require("@addmaple/lz4") as {
  init: () => Promise<void>;
  compress: (data: Uint8Array, options?: { level?: number }) => Promise<Uint8Array>;
};

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

  const CHUNK = 50 * 1024 * 1024; // 50MB
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
