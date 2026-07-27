/**
 * Zstd codec wrapper — Smart Archive VSCode Extension
 *
 * Uses zstd-napi (C++ Node-API, static zstd 1.5.7) for zstd compression.
 * Prioritises system zstd CLI for file compression; falls back to
 * zstd-napi when the system zstd binary is unavailable.
 *
 * Decompression (in-memory) is handled by zstd-napi; archive-level
 * decompression goes through js7z-tools (7z v24.01+).
 *
 * @module engines/zstd-codec
 */

import { logger } from "../utils/logger";
import { checkFileSize } from "../utils/security";
import * as vscode from "vscode";
import { t } from "../i18n";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import { CODEC_CHUNK } from "../constants";

type ZstdNative = {
  compress: (data: Buffer, opts?: { compressionLevel?: number }) => Buffer;
  decompress: (data: Buffer) => Buffer;
};

// Load the native binding lazily-tolerant: some platforms have no zstd-napi
// prebuild (Windows arm64 — upstream ships none — or Alpine/musl). A missing
// binding must NOT abort extension activation (this require runs at module
// load, reached from activate()); zstd operations degrade to system tools and
// surface a clear error only when actually invoked without a binding.
let zstdNative: ZstdNative | undefined;
try {
  zstdNative = require("zstd-napi") as ZstdNative;
} catch (err) {
  logger.warn(
    { event: "zstd.napi.unavailable", err },
    "zstd-napi native binding unavailable; zstd runs via system zstd only",
  );
}

function requireZstdNative(): ZstdNative {
  if (!zstdNative) throw new Error(t("zstd.nativeUnavailable"));
  return zstdNative;
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
  return requireZstdNative().compress(Buffer.from(data), { compressionLevel: mapZstdLevel(level) });
}

export async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  checkFileSize(data.byteLength);
  const result = requireZstdNative().decompress(Buffer.from(data));
  checkFileSize(result.byteLength);
  return result;
}

let sysZstdPath: string | null | false = null;

/**
 * Clear the cached system-zstd detection result so a change to
 * `smart-archive.useSystemZstd` takes effect without a window reload.
 * Without this, the first resolveSystemZstd() latches sysZstdPath (including
 * the `false` sentinel written on the "never" branch) for the whole session.
 */
export function resetZstdDetectionCache(): void {
  sysZstdPath = null;
}

function resolveSystemZstd(): string | null {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const setting = config.get<string>("useSystemZstd", "auto");

  if (setting === "never") {
    logger.debug({ event: "zstd.system.disabled" });
    sysZstdPath = false;
    return null;
  }

  if (sysZstdPath !== null) return sysZstdPath || null;
  try {
    const whichProc = spawnSync(process.platform === "win32" ? "where" : "which", ["zstd"], {
      timeout: 3000,
    });
    if (whichProc.status === 0) {
      sysZstdPath = whichProc.stdout.toString().trim().split("\n")[0].trim() || "zstd";
    } else {
      const verProc = spawnSync("zstd", ["--version"], { timeout: 3000 });
      sysZstdPath = verProc.status === 0 ? "zstd" : false;
    }
  } catch {
    sysZstdPath = false;
  }

  if (!sysZstdPath && setting === "always") {
    vscode.window.showWarningMessage(t("zstd.notAvailable"));
  }

  return sysZstdPath || null;
}

export function zstdCompressFile(input: string, output: string, level: number): Promise<void> {
  const zstdPath = resolveSystemZstd();
  if (zstdPath) {
    logger.info({ event: "zstd.compress.system", path: zstdPath });
    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(zstdPath, ["-o", output, "-f", `-${mapZstdLevel(level)}`, "-T0", input], {
        timeout: 120_000,
      });

      const stderrChunks: Buffer[] = [];
      proc.stderr?.on("data", (d: Buffer) => {
        stderrChunks.push(d);
      });

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          logger.info({ event: "zstd.compress.system.ok", input, output, level });
          resolve();
        } else {
          cleanup(output);
          const stderr = Buffer.concat(stderrChunks).toString();
          logger.error({
            event: "zstd.compress.system.failed",
            code,
            stderr: stderr.slice(0, 200),
            input,
            output,
          });
          reject(new Error(`zstd exited with code ${code}: ${stderr.slice(0, 200)}`));
        }
      });

      proc.on("error", () => {
        if (settled) return;
        cleanup(output);
        logger.warn(
          { event: "zstd.system.failed", path: zstdPath },
          "System zstd failed, falling back to native",
        );
        nativeCompressFile(input, output, level).then(
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

  logger.info({ event: "zstd.compress.native" });
  return nativeCompressFile(input, output, level);
}

function nativeCompressFile(input: string, output: string, level: number): Promise<void> {
  return Promise.resolve().then(() => {
    const CHUNK = CODEC_CHUNK;
    const rfd = fs.openSync(input, "r");
    const out = fs.openSync(output, "w");
    try {
      const native = requireZstdNative();
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      const zlevel = mapZstdLevel(level);
      while (true) {
        const n = fs.readSync(rfd, buf, 0, buf.length, pos);
        if (n === 0) break;
        const frame = native.compress(Buffer.from(buf.slice(0, n)), { compressionLevel: zlevel });
        fs.writeSync(out, frame);
        pos += n;
      }
      logger.info({ event: "zstd.compress.native.ok", input, output, level });
    } catch (err) {
      fs.closeSync(rfd);
      fs.closeSync(out);
      cleanup(output);
      throw err;
    } finally {
      try {
        fs.closeSync(rfd);
      } catch {
        logger.warn({ event: "zstd.compress.closeFailed" }, "Failed to close file descriptor");
      }
      try {
        fs.closeSync(out);
      } catch {
        logger.warn({ event: "zstd.compress.closeFailed" }, "Failed to close file descriptor");
      }
    }
  });
}

function cleanup(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    logger.warn({ event: "zstd.cleanup.failed", path }, "Failed to remove temp file");
  }
}
