/**
 * Zstd codec wrapper — Smart Archive VSCode Extension
 *
 * Uses zstd-napi (C++ Node-API, static zstd 1.5.7) for zstd compression.
 * Prioritises system zstd CLI for file compression; falls back to
 * zstd-napi when the system zstd binary is unavailable, and finally to
 * the bundled 7zz WASM engine (7-Zip ZS, zstd support) when the native
 * binding is missing or fails.
 *
 * Decompression (in-memory) is handled by the bundled 7zz WASM engine
 * (parallel -mmt); archive-level decompression goes through 7zz as well.
 *
 * @module engines/zstd-codec
 */

import { logger } from "../utils/logger-core";
import { checkFileSize } from "../utils/security";
import type { ProgressLike } from "../utils/cancellation";
import { t } from "../i18n";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import { CODEC_CHUNK } from "../constants";
import { shouldUseWasmCodec, wasmCompress, wasmCompressFile, wasmDecompress } from "./js7z-codec";

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
  if (!shouldUseWasmCodec()) {
    try {
      return requireZstdNative().compress(Buffer.from(data), {
        compressionLevel: mapZstdLevel(level),
      });
    } catch (err) {
      logger.warn(
        { event: "zstd.native.failed", err },
        "zstd-napi unavailable or failed, falling back to WASM",
      );
    }
  }
  logger.info({ event: "zstd.compress.wasm" });
  return wasmCompress(data, "zst", level);
}

export async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  checkFileSize(data.byteLength);
  logger.info({ event: "zstd.decompress.wasm" });
  const result = await wasmDecompress(data, "zst");
  checkFileSize(result.byteLength);
  return result;
}

let sysZstdPath: string | null | false = null;

/** Injected config: useSystemZstd setting + optional warning hook (host shows it). */
let zstdConfig: { useSystemZstd?: string; warn?: (message: string) => void } = {};

/**
 * Inject the useSystemZstd setting and a warning callback. The host wires
 * warn → vscode.window.showWarningMessage; worker threads receive the
 * setting at init and forward warnings as notify messages.
 */
export function setZstdConfig(config: {
  useSystemZstd?: string;
  warn?: (message: string) => void;
}): void {
  zstdConfig = config;
}

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
  const setting = zstdConfig.useSystemZstd ?? "auto";

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
    zstdConfig.warn?.(t("zstd.notAvailable"));
  }

  return sysZstdPath || null;
}

/**
 * Progress fallback for the system zstd CLI: like 7-Zip, zstd only prints
 * live progress on a console; when stderr is piped its "Read: X / Y" line
 * is emitted once at the end. Monitor the output file's growth instead.
 */
function monitorOutputGrowth(
  inputPath: string,
  outputPath: string,
  prog: ProgressLike,
  isSettled: () => boolean,
): ReturnType<typeof setInterval> | null {
  let total = 0;
  try {
    total = fs.statSync(inputPath).size;
  } catch {
    return null;
  }
  if (total <= 0) return null;
  let lastPct = 0;
  return setInterval(() => {
    if (isSettled()) return;
    let bytes = 0;
    try {
      bytes = fs.statSync(outputPath).size;
    } catch {
      return;
    }
    if (bytes <= 0) return;
    const pct = Math.min(99, Math.floor((bytes / total) * 100));
    if (pct > lastPct && pct > 0) {
      prog.report({ message: `${pct}%`, increment: pct - lastPct });
      lastPct = pct;
    }
  }, 200);
}

export function zstdCompressFile(
  input: string,
  output: string,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  if (shouldUseWasmCodec()) {
    logger.info({ event: "zstd.compress.wasm.forced" });
    return wasmCompressFile(input, output, "zst", level, progress);
  }

  const zstdPath = resolveSystemZstd();
  if (zstdPath) {
    logger.info({ event: "zstd.compress.system", path: zstdPath });
    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(zstdPath, ["-o", output, "-f", `-${mapZstdLevel(level)}`, "-T0", input], {
        timeout: 120_000,
      });

      const sizeTimer = progress
        ? monitorOutputGrowth(input, output, progress, () => settled)
        : null;

      const stderrChunks: Buffer[] = [];
      proc.stderr?.on("data", (d: Buffer) => {
        stderrChunks.push(d);
      });

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (sizeTimer) clearInterval(sizeTimer);
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
        settled = true;
        if (sizeTimer) clearInterval(sizeTimer);
        cleanup(output);
        logger.warn(
          { event: "zstd.system.failed", path: zstdPath },
          "System zstd failed, falling back to native then WASM",
        );
        nativeCompressFileWithWasmFallback(input, output, level, progress).then(
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
  return nativeCompressFileWithWasmFallback(input, output, level, progress);
}

function nativeCompressFileWithWasmFallback(
  input: string,
  output: string,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  return nativeCompressFile(input, output, level, progress).catch((err) => {
    logger.warn(
      { event: "zstd.native.compress.failed", err },
      "zstd-napi compression failed, falling back to WASM",
    );
    return wasmCompressFile(input, output, "zst", level, progress);
  });
}

function nativeCompressFile(
  input: string,
  output: string,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  return Promise.resolve().then(() => {
    const CHUNK = CODEC_CHUNK;
    const rfd = fs.openSync(input, "r");
    const out = fs.openSync(output, "w");
    const total = fs.fstatSync(rfd).size;
    let lastPct = 0;
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
        if (progress && total > 0) {
          const pct = Math.min(99, Math.floor((pos / total) * 100));
          if (pct > lastPct && pct > 0) {
            progress.report({ message: `${pct}%`, increment: pct - lastPct });
            lastPct = pct;
          }
        }
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
