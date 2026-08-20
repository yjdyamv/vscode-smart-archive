/**
 * Zstd codec wrapper — Smart Archiver VSCode Extension
 *
 * Prioritises the system zstd CLI (when enabled/found), otherwise uses the
 * bundled 7zz native binary and then the WASM engine (7-Zip ZS, zstd
 * support). No native Node addon is bundled anymore.
 *
 * NOTE: Node's built-in zlib zstd (v22.15+) was evaluated as a backend and
 * dropped: the API is still marked Experimental (Stability 1) on 22/24/26,
 * the documented `level` option is silently ignored by the runtime, and the
 * Electron node that VSCode actually runs builds zstd WITHOUT multithread
 * support (ZSTD_c_nbWorkers throws ERR_ZLIB_INITIALIZATION_FAILED), which
 * crashed every tar.zst creation in the real extension host.
 *
 * Decompression (in-memory) is handled by the bundled 7zz WASM engine
 * (parallel -mmt); archive-level decompression goes through 7zz as well.
 *
 * @module engines/zstd-codec
 */

import { logger } from "../utils/logger-core";
import type { ProgressLike } from "../utils/cancellation";
import { t } from "../i18n";
import { CODEC_SPAWN_MAX_BUFFER, CODEC_SPAWN_TIMEOUT_MS } from "../constants";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import { shouldUseWasmCodec, wasmCompress, wasmCompressFile, wasmDecompress } from "./js7z-codec";
import { nativeCompress, nativeCompressFile, nativeDecompress } from "./native-codec";

/**
 * Map the VSCode 0-9 compression level onto zstd's 0-22 range.
 *
 * Identity mapping (UI 1-9 → zstd 1-9, UI 0 → zstd 1), matching the
 * bundled 7zz's own `-mx0..9` interpretation (ZstdEncoder.cpp). A magnified
 * mapping (UI 9 → zstd 22) silently made the CLI tier ~78x slower at the
 * top of the range (zstd 15+ uses the btultra2 optimal parsers). zstd 15+
 * is only reachable through explicit `-m` parameters.
 */
function mapZstdLevel(uiLevel: number): number {
  return Math.min(9, Math.max(1, Math.floor(uiLevel)));
}

export async function zstdCompress(data: Uint8Array, level = 3): Promise<Uint8Array> {
  if (!shouldUseWasmCodec() && !zstdWasmForced()) {
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
      { event: "zstd.system.buffer.failed", err },
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
      { event: "zstd.system.buffer.decompress.failed", err },
      "System zstd decompression failed",
    );
  }
  return null;
}

export async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (!shouldUseWasmCodec() && !zstdWasmForced()) {
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
  return result;
}

let sysZstdPath: string | null | false = null;

/** Injected config: zstdBackend setting + optional warning hook (host shows it). */
let zstdConfig: { zstdBackend?: string; warn?: (message: string) => void } = {};

/**
 * Inject the zstdBackend setting and a warning callback. The host wires
 * warn → vscode.window.showWarningMessage; worker threads receive the
 * setting at init and forward warnings as notify messages.
 */
export function setZstdConfig(config: {
  zstdBackend?: string;
  warn?: (message: string) => void;
}): void {
  zstdConfig = config;
}

function zstdBackendSetting(): string {
  return zstdConfig.zstdBackend ?? "auto";
}

/** True when the setting forces the WASM engine for zstd. */
function zstdWasmForced(): boolean {
  return zstdBackendSetting() === "wasm";
}

/**
 * Clear the cached system-zstd detection result so a change to
 * `smart-archiver.backend.zstd` takes effect without a window reload.
 * Without this, the first resolveSystemZstd() latches sysZstdPath (including
 * the `false` sentinel written on the "wasm"/"bundled" branches) for the
 * whole session.
 */
export function resetZstdDetectionCache(): void {
  sysZstdPath = null;
}

/** Test-only seam: force the resolved system-zstd path (skips PATH lookup). */
export function setSystemZstdPathForTest(p: string | null): void {
  sysZstdPath = p;
}

function resolveSystemZstd(): string | null {
  const setting = zstdBackendSetting();

  // "wasm" forces the WASM engine and "bundled" routes to the VSIX 7zz
  // binary — neither ever uses the system CLI.
  if (setting === "wasm" || setting === "bundled") {
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

  if (!sysZstdPath && setting === "native") {
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
  if (shouldUseWasmCodec() || zstdWasmForced()) {
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
          logger.warn(
            {
              event: "zstd.compress.system.failed",
              code,
              stderr: stderr.slice(0, 200),
              input,
              output,
            },
            "System zstd compression failed, falling back to bundled 7zz then WASM",
          );
          fallbackNativeThenWasm(input, output, level, progress).then(resolve, reject);
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
