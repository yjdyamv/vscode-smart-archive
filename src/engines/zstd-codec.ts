/**
 * Zstd codec wrapper — Smart Archive VSCode Extension
 *
 * Uses @bokuweb/zstd-wasm for lightweight zstd compression.
 * Decompression is handled by js7z-tools (7z v24.01+ supports zstd decompression).
 *
 * @module engines/zstd-codec
 */

import { logger } from "../utils/logger";
import { checkFileSize } from "../utils/security";
import { spawn } from "child_process";
import * as fs from "fs";

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
  checkFileSize(data.byteLength);
  const result = zstd.decompress(data);
  checkFileSize(result.byteLength);
  return result;
}

let sysZstdPath: string | null | false = null;

function resolveSystemZstd(): string | null {
  if (sysZstdPath !== null) return sysZstdPath || null;
  try {
    const whichProc = require("child_process").spawnSync(
      process.platform === "win32" ? "where" : "which",
      ["zstd"],
      { timeout: 3000 },
    );
    if (whichProc.status === 0) {
      sysZstdPath = whichProc.stdout.toString().trim().split("\n")[0].trim() || "zstd";
    } else {
      // Try locating via --version as fallback
      const verProc = require("child_process").spawnSync("zstd", ["--version"], { timeout: 3000 });
      sysZstdPath = verProc.status === 0 ? "zstd" : false;
    }
  } catch {
    sysZstdPath = false;
  }
  return sysZstdPath || null;
}

export function zstdCompressFile(input: string, output: string, level: number): Promise<void> {
  const zstdPath = resolveSystemZstd();
  if (zstdPath) {
    logger.info({ event: "zstd.compress.system", path: zstdPath });
    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(
        zstdPath,
        [
          "-o",
          output,
          "-f",
          `-${mapZstdLevel(level)}`,
          "-T0", // auto threads
          input,
        ],
        { timeout: 120_000 },
      );

      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve();
        } else {
          cleanup(output);
          reject(new Error(`zstd exited with code ${code}: ${stderr.slice(0, 200)}`));
        }
      });

      proc.on("error", (err) => {
        if (settled) return;
        cleanup(output);
        logger.warn(
          { event: "zstd.system.failed", err, path: zstdPath },
          "System zstd failed, falling back to WASM",
        );
        // Fall through to WASM — resolve the outer promise via WASM result
        wasmCompressFile(input, output, level).then(
          () => {
            settled = true;
            resolve();
          },
          (e) => {
            settled = true;
            reject(e);
          },
        );
      });
    });
  }

  logger.info({ event: "zstd.compress.wasm" });
  return wasmCompressFile(input, output, level);
}

function wasmCompressFile(input: string, output: string, level: number): Promise<void> {
  // WASM chunked: compress file in 50MB chunks, 7z handles multi-frame decompression
  const CHUNK = 50 * 1024 * 1024;
  return ensureInit().then(() => {
    const rfd = fs.openSync(input, "r");
    const out = fs.openSync(output, "w");
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      while (true) {
        const n = fs.readSync(rfd, buf, 0, buf.length, pos);
        if (n === 0) break;
        const frame = zstd.compress(new Uint8Array(buf.slice(0, n)), mapZstdLevel(level));
        fs.writeSync(out, Buffer.from(frame));
        pos += n;
      }
    } finally {
      fs.closeSync(rfd);
      fs.closeSync(out);
    }
  });
}

function cleanup(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    /* ignore */
  }
}
