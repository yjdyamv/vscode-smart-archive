/**
 * Decompress API — Smart Archive VSCode Extension
 *
 * Pure business-logic functions for decompression operations.
 * These functions have zero VSCode UI dependency and can be
 * called programmatically by commands (production) or test
 * suites (verification).
 *
 * The decompressCommand in src/commands/decompress.ts delegates
 * to these functions after collecting user input via VSCode UI.
 *
 * @module api/decompress
 */

import * as path from "path";
import * as fs from "fs";
import type { DecompressOptions } from "../types";
import { decompressWith7z } from "../engines/js7z-decompress";
import { isEncrypted } from "../engines/js7z-list";
import {
  DECOMPRESS_EXTENSIONS,
  getFullExt,
  isEncryptableExt,
  MAX_COLLISION_RETRIES,
} from "../constants";
import { isRarExt, validateRarHeader } from "../utils/rar";
import { resolveEffectiveInput } from "../utils/path";
import { logger } from "../utils/logger";

// resolveEffectiveInput lives with the other path helpers (utils/path);
// re-exported here so the api/ surface stays a stable test entry point.
export { resolveEffectiveInput } from "../utils/path";

/**
 * Parameters for a decompression operation.
 * All VSCode-agnostic — callable from any environment.
 */
export interface DecompressParams {
  /** Path to the archive file */
  inputPath: string;
  /** Extraction output directory. Auto-generated if omitted. */
  outputDir?: string;
  /** Decryption password (empty = try without password) */
  password?: string;
  /** File extension override for format detection (e.g. "tar.gz"). Rarely needed. */
  ext?: string;
  /** Optional progress callback. Receives progress messages (e.g. "45%"). */
  onProgress?: (message: string) => void;
  /** Optional AbortSignal to cancel a long-running operation. */
  signal?: AbortSignal;
}

/**
 * Generate a collision-free output directory for extraction.
 * If the target exists, appends _1, _2, ... before the extension.
 *
 * @param inputPath - Original archive path
 * @returns A unique output directory path
 */
export function deriveOutputDir(inputPath: string): string {
  const ext = getFullExt(inputPath);
  const base = path.basename(inputPath, ext);
  const dir = path.dirname(inputPath);
  const suffix = "extracted";
  let output = path.join(dir, `${base}.${suffix}`);
  let counter = 1;
  while (fs.existsSync(output)) {
    if (counter > MAX_COLLISION_RETRIES) {
      throw new Error(`Failed to find unique output path after ${counter} attempts`);
    }
    output = path.join(dir, `${base}_${counter}.${suffix}`);
    counter++;
  }
  return output;
}

/**
 * Determine the effective file extension for format detection.
 * Resolves split-volume and RAR-volume suffixes to their base extension.
 *
 * @param inputPath - Path to the archive file
 * @param extOverride - Optional explicit extension
 */
export function resolveArchiveExt(inputPath: string, extOverride?: string): string {
  if (extOverride) return extOverride;
  return getFullExt(inputPath);
}

/**
 * Check whether an archive is encrypted (if detectable).
 * Returns false for formats that don't support encryption.
 *
 * @param inputPath - Path to the archive file
 * @throws If the file cannot be read
 */
export async function detectEncryption(inputPath: string): Promise<boolean> {
  const ext = getFullExt(inputPath);

  if (!isEncryptableExt(ext)) return false;

  try {
    return await isEncrypted(inputPath);
  } catch {
    logger.warn(
      { event: "api.decompress.isEncrypted.failed", inputPath },
      "Cannot detect encryption, assuming unencrypted",
    );
    return false;
  }
}

/**
 * Validate that an archive file can be processed.
 * Checks existence, RAR headers, and known format support.
 * Returns an array of warning messages (empty = all good).
 */
export function validateArchive(inputPath: string): string[] {
  const warnings: string[] = [];

  if (isRarExt(getFullExt(inputPath))) {
    try {
      validateRarHeader(inputPath);
    } catch {
      warnings.push("Cannot read RAR header — file may be corrupted.");
    }
  }

  const ext = getFullExt(inputPath);
  if (!isRarExt(ext) && !(DECOMPRESS_EXTENSIONS as readonly string[]).includes(ext)) {
    warnings.push(`Unknown archive format: ${ext}`);
  }

  return warnings;
}

interface ProgressReporter {
  report: (v: { message?: string }) => void;
}

/**
 * Execute a decompression operation.
 *
 * This is the primary programmatic entry point for extracting archives.
 * It performs format detection, encryption checking, volume resolution,
 * decompression, and inner-tar unwrapping — exactly as the decompressCommand
 * does, but without any VSCode UI interaction.
 *
 * @returns The absolute path to the extraction output directory.
 * @throws On 7z errors, permission issues, or decompression failures.
 *
 * @example
 *   const outDir = await decompress({
 *     inputPath: "/downloads/archive.7z",
 * @example
 *   const outDir = await decompress({
 *     inputPath: "/downloads/archive.7z",
 *     password: "secret",
 *     onProgress: (msg) => console.log(msg),
 *   });
 */
export async function decompress(params: DecompressParams): Promise<string> {
  // Early validation for clear error messages before entering the engine
  const warnings = validateArchive(params.inputPath);
  if (warnings.length > 0) {
    throw new Error(warnings.join("\n"));
  }

  const effectiveInput = resolveEffectiveInput(params.inputPath);
  const outputDir = params.outputDir ?? deriveOutputDir(effectiveInput);

  // Adapt VSCode-agnostic callbacks to engine-compatible shapes
  const progress: ProgressReporter | undefined = params.onProgress
    ? { report: (v: { message?: string }) => params.onProgress?.(v.message ?? "") }
    : undefined;

  let token:
    | {
        readonly isCancellationRequested: boolean;
        onCancellationRequested(cb: () => void): { dispose(): void };
      }
    | undefined = undefined;
  if (params.signal) {
    const signal = params.signal;
    token = {
      get isCancellationRequested() {
        return signal.aborted;
      },
      onCancellationRequested(cb: () => void) {
        signal.addEventListener("abort", cb, { once: true });
        return { dispose: () => signal.removeEventListener("abort", cb) };
      },
    };
  }

  logger.info({
    event: "api.decompress.start",
    inputPath: effectiveInput,
    outputDir,
  });

  const decompressOpts: DecompressOptions = {
    inputPath: effectiveInput,
    outputDir,
    password: params.password ?? "",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await decompressWith7z(decompressOpts, progress, token as any);

  logger.info({
    event: "api.decompress.done",
    outputDir,
  });

  return outputDir;
}
