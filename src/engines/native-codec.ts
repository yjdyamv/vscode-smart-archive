/**
 * Native 7-Zip ZS codec fast path (zstd / lz4 single-file streams).
 *
 * Uses the bundled native 7zz (mcmilk fork) when present; callers fall back
 * to the WASM engine when this returns false/null. The bundled binary is the
 * only native tier for these codecs — stock system 7-Zip cannot create
 * standard .zst/.lz4 files reliably, and the user chose bundled-native first.
 *
 * @module engines/native-codec
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import type { ProgressLike } from "../utils/cancellation";
import { checkFileSize } from "../utils/security";
import { logger } from "../utils/logger-core";
import { bundled7zPath } from "./bundled7z";

export type NativeCodec = "zst" | "lz4";

// bundled7zPath() re-validates the binary on every call; cache per session.
let _cachedBundled: string | null | undefined;

function native7zz(): string | null {
  if (_cachedBundled === undefined) _cachedBundled = bundled7zPath();
  return _cachedBundled;
}

/** zstd has an official MT format; lz4 stays standard single-stream. */
function mtArg(codec: NativeCodec): string {
  return codec === "zst" ? "-mmt=on" : "-mmt=off";
}

/** Progress fallback: monitor the output file's growth on disk. */
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

function cleanup(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // best effort
  }
}

/** Spawn the bundled 7zz; resolves true on exit 0. */
function run7zz(args: string[]): Promise<void> {
  const sz = native7zz();
  if (!sz) return Promise.reject(new Error("no bundled 7zz"));
  return new Promise((resolve, reject) => {
    const proc = spawn(sz, args, { windowsHide: true });
    const stderr: Buffer[] = [];
    proc.stderr?.on("data", (d: Buffer) => stderr.push(d));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`7zz exited ${code}: ${Buffer.concat(stderr).toString().slice(0, 200)}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

/**
 * Compress a file to a standard .zst/.lz4 stream with the bundled 7zz.
 * Returns false when no bundled binary exists or the run fails.
 */
export async function nativeCompressFile(
  input: string,
  output: string,
  codec: NativeCodec,
  level: number,
  progress?: ProgressLike,
): Promise<boolean> {
  if (!native7zz()) return false;
  let reportedPct = 0;
  const prog: ProgressLike | undefined = progress
    ? {
        report(r) {
          if (typeof r.increment === "number" && r.increment > 0) {
            reportedPct = Math.min(100, reportedPct + r.increment);
          }
          progress.report(r);
        },
      }
    : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const sz = native7zz()!;
      const proc = spawn(sz, ["a", output, input, `-mx${level}`, mtArg(codec)], {
        windowsHide: true,
      });
      let settled = false;
      const timer = prog ? monitorOutputGrowth(input, output, prog, () => settled) : null;
      const stderr: Buffer[] = [];
      proc.stderr?.on("data", (d: Buffer) => stderr.push(d));
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        if (code === 0) {
          if (prog && reportedPct < 100) {
            prog.report({ message: "100%", increment: 100 - reportedPct });
          }
          resolve();
        } else {
          cleanup(output);
          reject(
            new Error(
              `7zz codec compress exited ${code}: ${Buffer.concat(stderr).toString().slice(0, 200)}`,
            ),
          );
        }
      });
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        cleanup(output);
        reject(err);
      });
    });
    logger.info({ event: "nativeCodec.compress.ok", codec, input, output, level });
    return true;
  } catch (err) {
    logger.warn({ event: "nativeCodec.compress.failed", codec, err });
    cleanup(output);
    return false;
  }
}

/**
 * Decompress a standard .zst/.lz4 stream to a file with the bundled 7zz.
 * Returns false when no bundled binary exists or the run fails.
 */
export async function nativeDecompressFile(
  input: string,
  output: string,
  codec: NativeCodec,
): Promise<boolean> {
  if (!native7zz()) return false;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa7zn_"));
  try {
    await run7zz(["x", input, `-o${tmpDir}`, "-y", mtArg(codec)]);
    const entries = fs.readdirSync(tmpDir).filter((e) => e !== "." && e !== "..");
    if (entries.length !== 1) {
      throw new Error(`Unexpected 7zz ${codec} output: ${entries.join(", ") || "(empty)"}`);
    }
    fs.copyFileSync(path.join(tmpDir, entries[0]), output);
    logger.info({ event: "nativeCodec.decompress.ok", codec, input, output });
    return true;
  } catch (err) {
    logger.warn({ event: "nativeCodec.decompress.failed", codec, err });
    cleanup(output);
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** In-memory compression through temp files; null when the native path fails. */
export async function nativeCompress(
  data: Uint8Array,
  codec: NativeCodec,
  level: number,
): Promise<Buffer | null> {
  if (!native7zz()) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa7nzc_"));
  const input = path.join(tmpDir, "input.bin");
  const output = path.join(tmpDir, `archive.${codec}`);
  try {
    fs.writeFileSync(input, Buffer.from(data));
    if (!(await nativeCompressFile(input, output, codec, level))) return null;
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** In-memory decompression through temp files; null when the native path fails. */
export async function nativeDecompress(
  data: Uint8Array,
  codec: NativeCodec,
): Promise<Buffer | null> {
  checkFileSize(data.byteLength);
  if (!native7zz()) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa7nzd_"));
  const input = path.join(tmpDir, `archive.${codec}`);
  const output = path.join(tmpDir, "output.bin");
  try {
    fs.writeFileSync(input, Buffer.from(data));
    if (!(await nativeDecompressFile(input, output, codec))) return null;
    const result = fs.readFileSync(output);
    checkFileSize(result.byteLength);
    return result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
