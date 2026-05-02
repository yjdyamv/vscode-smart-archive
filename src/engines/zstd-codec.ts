/**
 * Zstd codec wrapper — Smart Archive VSCode Extension
 *
 * Uses @bokuweb/zstd-wasm for lightweight zstd compression.
 * Decompression is handled by js7z-tools (7z v24.01+ supports zstd decompression).
 *
 * @module engines/zstd-codec
 */

import { logger } from "../utils/logger";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const zstd = require("@bokuweb/zstd-wasm") as {
  init: () => Promise<void>;
  compress: (data: Uint8Array, level?: number) => Uint8Array;
  decompress: (data: Uint8Array) => Uint8Array;
};

let initP: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initP) {
    initP = zstd.init().catch((err) => {
      logger.error({ event: "zstd.init.failed", err }, "Zstd initialization failed");
      initP = null;
      throw err;
    });
  }
  return initP;
}

/**
 * Map VSCode 0-9 compression level to zstd's 0-22 range.
 * zstd supports much higher levels than 7z/zip.
 */
function mapZstdLevel(uiLevel: number): number {
  if (uiLevel <= 0) return 1;
  if (uiLevel <= 3) return 3;
  if (uiLevel <= 5) return 9;
  if (uiLevel <= 7) return 15;
  return 22;
}

export async function zstdCompress(data: Uint8Array, level = 3): Promise<Uint8Array> {
  await ensureInit();
  return zstd.compress(data, mapZstdLevel(level));
}

export async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  await ensureInit();
  return zstd.decompress(data);
}
