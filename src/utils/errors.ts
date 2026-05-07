/**
 * Typed error classes — Smart Archive VSCode Extension
 *
 * Replaces string-based error matching with instanceof checks for
 * reliable error discrimination across engine backends.
 *
 * @module utils/errors
 */

/** Base error for engine-level failures (WASM or system 7z). */
export class EngineError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** Archive cannot be opened (corrupted, not an archive, missing volumes). */
export class NotAnArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAnArchiveError";
  }
}

/**
 * Check an error from engine output for typical "cannot open" patterns.
 * Used as a fallback when the engine doesn't provide structured error info
 * (e.g. system 7z spawn errors, or parse failures in older code paths).
 */
export function isNotAnArchiveError(err: unknown): boolean {
  if (err instanceof NotAnArchiveError) return true;
  const msg = (err as Error).message || "";
  return /can\s*not\s*open|unexpected\s+end|missing\s+volume/i.test(msg);
}
