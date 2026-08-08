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
import type { LogLevel } from "../../utils/logger-core";
import type { ProgressStage } from "../../utils/cancellation";

export type ArchiveOp = "compress" | "decompress" | "list" | "isEncrypted" | "modify" | "unwrap";

export interface EngineConfig {
  locale: string;
  limits: { maxArchiveSize?: number; maxExtractTotalSize?: number };
  useSystemZstd?: string;
  /** Brotli backend: node | wasm | 7z (bundled 7z planned) */
  brotliBackend?: string;
  /** RAR5 backend: auto | native | wasm */
  rar5Backend?: "auto" | "native" | "wasm";
  /** Snappy backend: auto | native | wasm */
  snappyBackend?: "auto" | "native" | "wasm";
  /** Worker RSS memory guard threshold in MiB (0 = disabled) */
  workerMemoryMb?: number;
  /** Default compression level (0-9) for wrapped-format mutations */
  compressionLevel?: number;
  /** Output-channel verbosity (matches smart-archive.logLevel) */
  logLevel?: LogLevel;
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

export interface ListPayload {
  inputPath: string;
  password?: string;
  /** In-memory archive bytes (overrides reading from inputPath) */
  data?: Uint8Array;
}

export type ModifyPayload =
  | {
      action: "add";
      archivePath: string;
      localPaths: string[];
      targetDir: string;
      password?: string;
      excludePatterns?: string[];
    }
  | {
      action: "delete";
      archivePath: string;
      paths: string[];
      password?: string;
    }
  | {
      action: "rename";
      archivePath: string;
      oldPath: string;
      newPath: string;
      password?: string;
    }
  | {
      action: "createFolder";
      archivePath: string;
      targetDir: string;
      folderName: string;
      password?: string;
    }
  | {
      action: "preview";
      archivePath: string;
      filePath: string;
      password?: string;
      /** Host-managed temp file the worker writes the extracted bytes to */
      outputPath: string;
    }
  | {
      action: "test";
      archivePath: string;
      password?: string;
    }
  | {
      action: "extract";
      archivePath: string;
      paths: string[];
      password?: string;
      flat?: boolean;
      outputDir: string;
      excludes?: string[];
    };

export type RequestPayload =
  | CompressPayload
  | DecompressPayload
  | ListPayload
  | ModifyPayload
  | UnwrapPayload;

export interface UnwrapPayload {
  /** Directory containing extracted files with possible inner tars */
  outputDir: string;
}

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
  stage?: ProgressStage;
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
  /** Operation result (e.g. the entry list for op "list") */
  result?: unknown;
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
