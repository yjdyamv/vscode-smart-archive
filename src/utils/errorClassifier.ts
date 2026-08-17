/**
 * Error classification helpers — Smart Archiver VSCode Extension
 *
 * Centralizes string-based error classification for 7z engine outputs.
 * String matching is unavoidable here because 7z CLI outputs vary by locale
 * and engine (WASM vs system), with no structured error codes available.
 *
 * @module utils/errorClassifier
 */

/**
 * Check whether an error message indicates password/encryption-related failure.
 * Used across WASM and system 7z engines for consistent error classification.
 */
export function isPasswordOrEncryptError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("encrypt") ||
    lower.includes("password") ||
    lower.includes("cannot open") ||
    lower.includes("wrong")
  );
}
