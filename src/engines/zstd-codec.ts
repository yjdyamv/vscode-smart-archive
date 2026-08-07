/**
 * Zstd codec wrapper — Smart Archive VSCode Extension
 *
 * zstd codec wrapper — Smart Archive VSCode Extension
 *
 * Prioritises the system zstd CLI (when enabled/found), otherwise uses the
 * bundled 7zz WASM engine (7-Zip ZS, zstd support). No native Node addon is
 * bundled anymore.
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
import { CODEC_SPAWN_MAX_BUFFER, CODEC_SPAWN_TIMEOUT_MS } from "../constants";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import { shouldUseWasmCodec, wasmCompress, wasmCompressFile, wasmDecompress } from "./js7z-codec";
import { nativeCompress, nativeCompressFile, nativeDecompress } from "./native-codec";

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
    const systemOut = systemCompressBuffer(Buffer.from(data), level);
    if (systemOut) {
      logger.info({ event: "zstd.compress.system.buffer", path: resolveSystemZstd() });
      return systemOut;
    }
    const nativeOut = await nativeCompress(data, "zst", level);
    if (nativeOut) {
      logger.info({ event: "zstd.compress.native" });
      return nativeOut;
    }
  }
  logger.info({ event: "zstd.compress.wasm" });
  return wasmCompress(data, "zst", level);
}

/** Compress a whole buffer through the system zstd CLI; null when unavailable. */
function systemCompressBuffer(data: Buffer, level: number): Buffer | null {
  const zstdPath = resolveSystemZstd();
  if (!zstdPath) return null;
  try {
    const r = spawnSync(zstdPath, ["-q", "-c", "-f", `-${mapZstdLevel(level)}`], {
      input: data,
      maxBuffer: CODEC_SPAWN_MAX_BUFFER,
      timeout: CODEC_SPAWN_TIMEOUT_MS,
    });
    if (r.status === 0) return r.stdout;
    logger.warn(
      { event: "zstd.system.buffer.failed", code: r.status, path: zstdPath },
      "System zstd buffer compression failed, falling back to WASM",
    );
  } catch (err) {
    logger.warn(
      { event: "zstd.system.buffer.error", err },
      "System zstd buffer compression failed",
    );
  }
  return null;
}

/** Decompress a whole buffer through the system zstd CLI; null when unavailable. */
function systemDecompressBuffer(data: Buffer): Buffer | null {
  const zstdPath = resolveSystemZstd();
  if (!zstdPath) return null;
  try {
    const r = spawnSync(zstdPath, ["-q", "-d", "-c"], {
      input: data,
      maxBuffer: CODEC_SPAWN_MAX_BUFFER,
      timeout: CODEC_SPAWN_TIMEOUT_MS,
    });
    if (r.status === 0) return r.stdout;
    logger.warn(
      { event: "zstd.system.buffer.decompress.failed", code: r.status, path: zstdPath },
      "System zstd buffer decompression failed, falling back",
    );
  } catch (err) {
    logger.warn(
      { event: "zstd.system.buffer.decompress.error", err },
      "System zstd decompression failed",
    );
  }
  return null;
}

export async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  checkFileSize(data.byteLength);
  if (!shouldUseWasmCodec()) {
    const systemOut = systemDecompressBuffer(Buffer.from(data));
    if (systemOut) {
      logger.info({ event: "zstd.decompress.system" });
      return systemOut;
    }
    const nativeOut = await nativeDecompress(data, "zst");
    if (nativeOut) {
      logger.info({ event: "zstd.decompress.native" });
      return nativeOut;
    }
  }
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
        timeout: CODEC_SPAWN_TIMEOUT_MS,
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
          "System zstd failed, falling back to bundled 7zz then WASM",
        );
        fallbackNativeThenWasm(input, output, level, progress).then(
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

  logger.info({ event: "zstd.compress.native.bundled" });
  return fallbackNativeThenWasm(input, output, level, progress);
}

async function fallbackNativeThenWasm(
  input: string,
  output: string,
  level: number,
  progress?: ProgressLike,
): Promise<void> {
  if (await nativeCompressFile(input, output, "zst", level, progress)) return;
  logger.info({ event: "zstd.compress.wasm" });
  await wasmCompressFile(input, output, "zst", level, progress);
}

function cleanup(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    logger.warn({ event: "zstd.cleanup.failed", path }, "Failed to remove temp file");
  }
}
