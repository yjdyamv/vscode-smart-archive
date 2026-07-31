/**
 * Worker protocol types — Smart Archive VSCode Extension
 *
 * Structured messages exchanged between the extension host and the
 * worker_threads archive worker (src/engines/worker/worker.ts).
 *
 * Host → worker: init / reconfigure / request / cancel / shutdown
 * Worker → host: ready / progress / log / notify / done / error
 *
 * @module engines/worker/types
 */

import type { CompressOptions, DecompressOptions } from "../../types";

export type ArchiveOp = "compress" | "decompress";

export interface EngineConfig {
  locale: string;
  limits: { maxFileSize?: number; maxTotalSize?: number };
  useSystemZstd?: string;
}

export interface InitMessage {
  type: "init";
  config: EngineConfig;
}

export interface ReconfigureMessage {
  type: "reconfigure";
  config: EngineConfig;
}

export interface CompressPayload {
  options: CompressOptions;
  excludePatterns?: string[];
}

export interface DecompressPayload {
  options: DecompressOptions;
}

export type RequestPayload = CompressPayload | DecompressPayload;

export interface RequestMessage {
  type: "request";
  id: number;
  op: ArchiveOp;
  payload: RequestPayload;
}

export interface CancelMessage {
  type: "cancel";
  id: number;
}

export interface ShutdownMessage {
  type: "shutdown";
}

export type HostMessage =
  | InitMessage
  | ReconfigureMessage
  | RequestMessage
  | CancelMessage
  | ShutdownMessage;

export interface ReadyMessage {
  type: "ready";
}

export interface ProgressMessage {
  type: "progress";
  id: number;
  message?: string;
  increment?: number;
}

export interface LogMessage {
  type: "log";
  /** JSON line as emitted by pino (logger-core) */
  chunk: string;
}

export interface NotifyMessage {
  type: "notify";
  /** Human-readable warning to surface via vscode.window */
  message: string;
}

export interface DoneMessage {
  type: "done";
  id: number;
}

export interface ErrorMessage {
  type: "error";
  id: number;
  message: string;
  name?: string;
  stack?: string;
  /** true when the operation was cancelled (→ host throws vscode.CancellationError) */
  cancelled?: boolean;
}

export type WorkerMessage =
  | ReadyMessage
  | ProgressMessage
  | LogMessage
  | NotifyMessage
  | DoneMessage
  | ErrorMessage;
