/**
 * Cancellation & progress abstractions — Smart Archive VSCode Extension
 *
 * Vscode-free equivalents of vscode.CancellationToken / vscode.Progress /
 * vscode.CancellationError. Structurally compatible with the real vscode
 * types, so host-side code can keep passing genuine vscode objects.
 * Worker-side code (worker_threads cannot import the vscode module) uses
 * these instead.
 *
 * @module utils/cancellation
 */

/**
 * Error thrown by vscode-free engine code when an operation is cancelled.
 * Name matches vscode.CancellationError ("Cancelled") so isCancellationError
 * recognises both without importing vscode.
 */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

/**
 * True for vscode.CancellationError and CancelledError alike.
 * Use at every catch site that previously did `instanceof vscode.CancellationError`.
 */
export function isCancellationError(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  if (err instanceof Error && err.name === "Cancelled") return true;
  return false;
}

/** Minimal cancellation-token shape (matches vscode.CancellationToken). */
export interface TokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): { dispose(): void };
}

/** Minimal progress shape (matches vscode.Progress<T>). */
export interface ProgressLike<T = { message?: string; increment?: number }> {
  report(value: T): void;
}
