/**
 * Error classification — Smart Archiver VSCode Extension
 *
 * Message-pattern fallback for recognizing "cannot open" failures when the
 * engine does not provide structured error info (system 7z spawn errors,
 * parse failures in legacy code paths).
 *
 * @module utils/errors
 */

/**
 * Check an error from engine output for typical "cannot open" patterns.
 * Used as a fallback when the engine doesn't provide structured error info
 * (e.g. system 7z spawn errors, or parse failures in older code paths).
 */
export function isNotAnArchiveError(err: unknown): boolean {
  const msg = (err as Error).message || "";
  return /can\s*not\s*open|unexpected\s+end|missing\s+volume/i.test(msg);
}

/**
 * The previewed entry exceeds MAX_PREVIEW_FILE_SIZE. Sentinel class so the
 * host preview path can tell "extraction failed" (fall back to WASM) from
 * "file is simply too large" — a WASM retry would hit the same limit after
 * another full decompression, so the error must propagate instead.
 */
export class PreviewTooLargeError extends Error {
  readonly size: number;
  readonly max: number;

  constructor(message: string, size: number, max: number) {
    super(message);
    this.name = "PreviewTooLargeError";
    this.size = size;
    this.max = max;
  }
}
