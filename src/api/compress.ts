/**
 * Compress API — Smart Archive VSCode Extension
 *
 * Pure business-logic functions for compression operations.
 * These functions have zero VSCode UI dependency and can be
 * called programmatically by commands (production) or test
 * suites (verification).
 *
 * The compressCommand in src/commands/compress.ts delegates
 * to these functions after collecting user input via VSCode UI.
 *
 * @module api/compress
 */

import * as path from "path";
import * as fs from "fs";
import type { CompressOptions } from "../types";
import { compressWith7z } from "../engines/js7z-compress";
import { COMPRESS_EXCLUDE_DEFAULTS, lookupFormat } from "../constants";
import { validatePassword } from "../utils/security";
import { logger } from "../utils/logger";

// Production helpers live next to their data (constants) and their domain
// (utils/path); re-exported here so the api/ surface stays a stable test
// entry point without hosting the logic.
export { lookupFormat } from "../constants";
export { resolveSaveName } from "../utils/path";

/**
 * Parameters for a compression operation.
 * All VSCode-agnostic — callable from any environment.
 */
export interface CompressParams {
  /** Absolute paths to files/folders to compress */
  targets: string[];
  /** Format label (e.g. "7z", "zip", "tar.gz", "tar.zst") */
  format: string;
  /** Output archive path. Auto-generated from targets + format if omitted. */
  outputPath?: string;
  /** AES encryption password (empty = no encryption) */
  password?: string;
  /** Compression level 0-9 (default 5) */
  level?: number;
  /** Split into volumes (e.g. "100m", "1g"). Unset = single file. */
  volumeSize?: string;
  /** Glob/name patterns to exclude (defaults to COMPRESS_EXCLUDE_DEFAULTS) */
  excludePatterns?: string[];
  /** Optional progress callback. Receives progress messages (e.g. "45%"). */
  onProgress?: (message: string) => void;
  /** Optional AbortSignal to cancel a long-running operation. */
  signal?: AbortSignal;
}

/**
 * Generate a default output path when none is provided.
 *
 * - Single target: derives from target name (mountain → mountain.7z)
 * - Multiple targets: uses "archive" as base name
 *
 * @param targets - Compression target paths
 * @param format - Format label (e.g. "7z", "zip")
 * @param outputDir - Directory for the archive (defaults to dir of first target)
 */
export function resolveOutputPath(targets: string[], format: string, outputDir?: string): string {
  const ext = format; // format label IS the extension (e.g. "7z", "tar.gz")
  const firstTarget = targets[0];
  const dir = outputDir ?? path.dirname(firstTarget);

  if (targets.length === 1) {
    const baseName = path.basename(firstTarget);
    return path.join(dir, `${baseName}.${ext}`);
  }
  return path.join(dir, `archive.${ext}`);
}

/**
 * Build a CompressOptions struct from user-facing CompressParams.
 * Performs validation (password, format lookup) but does NOT touch
 * the filesystem or start compression.
 */
export function buildCompressOptions(params: CompressParams): CompressOptions {
  const format = lookupFormat(params.format);

  if (params.password) {
    validatePassword(params.password);
  }

  const outputPath = params.outputPath ?? resolveOutputPath(params.targets, params.format);

  return {
    targets: params.targets.map((t) => ({ fsPath: t })),
    format,
    outputPath,
    password: params.password ?? "",
    level: params.level ?? 5,
    volumeSize: params.volumeSize,
  };
}

interface ProgressReporter {
  report: (v: { message?: string }) => void;
}

/**
 * Execute a compression operation.
 *
 * This is the primary programmatic entry point for creating archives.
 * It performs format dispatching, password validation, exclusion filtering,
 * wrapped-format creation, split-volume handling, and writes the archive
 * to disk — exactly as the compressCommand wizard does, but without any
 * VSCode UI interaction.
 *
 * @returns The absolute path to the created archive file.
 * @throws On format errors, password validation failures, or 7z errors.
 *
 * @example
 *   const outPath = await compress({
 *     targets: ["/home/user/project"],
 *     format: "7z",
 *     password: "secret",
 *     level: 9,
 *     excludePatterns: ["node_modules", ".git"],
 *     onProgress: (msg) => console.log(msg),
 *   });
 */
export async function compress(params: CompressParams): Promise<string> {
  const compressOpts = buildCompressOptions(params);
  const excludePatterns = params.excludePatterns ?? COMPRESS_EXCLUDE_DEFAULTS;

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
    event: "api.compress.start",
    format: params.format,
    targets: params.targets.length,
    level: params.level,
    outputPath: compressOpts.outputPath,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await compressWith7z(compressOpts, progress, token as any, excludePatterns);

  logger.info({
    event: "api.compress.done",
    outputPath: compressOpts.outputPath,
  });

  return compressOpts.outputPath;
}

/**
 * Validate that all target paths exist on disk.
 * Returns an array of error messages (empty = all valid).
 */
export function validateTargetPaths(targets: string[]): string[] {
  const errors: string[] = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      errors.push(`Target does not exist: ${target}`);
    }
  }
  return errors;
}
