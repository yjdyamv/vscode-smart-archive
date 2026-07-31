/**
 * Worker runner — Smart Archive VSCode Extension
 *
 * Host-side gateway to the archive worker_threads worker. Owns a single
 * long-lived Worker (out/worker/worker.js), a FIFO request queue, progress
 * forwarding, cancellation messaging, crash recovery, and an in-process
 * fallback used in tests / dev when the worker bundle is unavailable.
 *
 * The dispatchers (js7z-compress / js7z-decompress) are the only callers.
 *
 * @module engines/worker/runner
 */

import { Worker } from "worker_threads";
import * as path from "path";
import * as vscode from "vscode";
import type { ArchiveOp, EngineConfig, RequestPayload, WorkerMessage } from "./types";
import { compressWith7z as compressCore } from "../js7z-compress-core";
import { decompressWith7z as decompressCore } from "../js7z-decompress-core";
import { writeHostLog, logger } from "../../utils/logger";
import type { TokenLike, ProgressLike } from "../../utils/cancellation";

interface PendingRequest {
  id: number;
  op: ArchiveOp;
  payload: RequestPayload;
  progress?: ProgressLike;
  token?: TokenLike;
  cancelSub?: { dispose(): void };
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface ArchiveRunner {
  run(
    op: ArchiveOp,
    payload: RequestPayload,
    progress?: ProgressLike,
    token?: TokenLike,
  ): Promise<void>;
  dispose(): void;
}

let nextId = 1;
let _active: ArchiveRunner | null = null;

function activeRunner(): ArchiveRunner {
  if (!_active) _active = new WorkerThreadRunner();
  return _active;
}

/** Replace the active runner (tests force the in-process runner). */
export function setArchiveRunner(runner: ArchiveRunner): void {
  _active?.dispose();
  _active = runner;
}

/** Run a compress/decompress op through the active runner. */
export function runArchiveOp(
  op: ArchiveOp,
  payload: RequestPayload,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<void> {
  return activeRunner().run(op, payload, progress, token);
}

/** Read the engine-relevant config from vscode (same values as utils/config). */
function currentConfig(): EngineConfig {
  const raw = vscode.workspace.getConfiguration("smart-archive");
  const maxFileSize = raw.get<string | number>("maxFileSize");
  const maxTotalSize = raw.get<string | number>("maxTotalSize");
  return {
    locale: vscode.env.language,
    limits: {
      maxFileSize: parseSize(maxFileSize, 1024 * 1024 * 1024),
      maxTotalSize: parseSize(maxTotalSize, 10 * 1024 * 1024 * 1024),
    },
    useSystemZstd: raw.get<string>("useSystemZstd", "auto"),
  };
}

function parseSize(raw: string | number | undefined, defaultBytes: number): number {
  if (raw === undefined || raw === null) return defaultBytes;
  if (typeof raw === "number") return raw > 0 ? raw : defaultBytes;
  const m = String(raw)
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(k|m|g)$/i);
  if (!m) return defaultBytes;
  const num = parseFloat(m[1]);
  const multipliers: Record<string, number> = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  return Math.round(num * multipliers[m[2].toLowerCase()]);
}

/**
 * In-process runner — executes the vscode-free core pipeline on the host.
 * Used by tests (vitest) and as a dev fallback when the worker bundle is
 * missing. System-7z fast paths still run as usual (child process).
 */
export class InProcessRunner implements ArchiveRunner {
  run(
    op: ArchiveOp,
    payload: RequestPayload,
    progress?: ProgressLike,
    token?: TokenLike,
  ): Promise<void> {
    if (op === "compress") {
      const p = payload as {
        options: Parameters<typeof compressCore>[0];
        excludePatterns?: string[];
      };
      return compressCore(p.options, progress, token, p.excludePatterns);
    }
    const p = payload as { options: Parameters<typeof decompressCore>[0] };
    return decompressCore(p.options, progress, token);
  }

  dispose(): void {
    // nothing to dispose
  }
}

/**
 * Worker-thread runner — a single lazy-spawned Worker with a FIFO queue.
 */
export class WorkerThreadRunner implements ArchiveRunner {
  private worker: Worker | null = null;
  private ready = false;
  private failed = false;
  private queue: PendingRequest[] = [];
  private current: PendingRequest | null = null;

  constructor(
    private readonly createWorker: (workerPath: string) => Worker = (p) => new Worker(p),
  ) {}

  run(
    op: ArchiveOp,
    payload: RequestPayload,
    progress?: ProgressLike,
    token?: TokenLike,
  ): Promise<void> {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const request: PendingRequest = {
      id: nextId++,
      op,
      payload,
      progress,
      token,
      promise,
      resolve,
      reject,
    };

    if (token?.isCancellationRequested) {
      reject(new vscode.CancellationError());
      return promise;
    }

    this.queue.push(request);
    request.cancelSub = token?.onCancellationRequested?.(() => {
      const idx = this.queue.indexOf(request);
      if (idx >= 0) {
        this.queue.splice(idx, 1);
        request.cancelSub?.dispose();
        request.reject(new vscode.CancellationError());
      } else if (this.current === request) {
        this.post({ type: "cancel", id: request.id });
      }
    });
    this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.current || this.queue.length === 0) return;
    const request = this.queue.shift()!;
    this.current = request;
    try {
      await this.ensureWorker();
      if (request.token?.isCancellationRequested) throw new vscode.CancellationError();
      this.post({ type: "request", id: request.id, op: request.op, payload: request.payload });
      // Settles when the worker replies done/error (or the worker crashes).
      await request.promise;
    } catch (err) {
      if (this.current === request) {
        request.reject(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      request.cancelSub?.dispose();
      if (this.current === request) this.current = null;
      // Reject anything that was cancelled while we were busy.
      while (this.queue.length > 0 && this.queue[0].token?.isCancellationRequested) {
        const cancelled = this.queue.shift()!;
        cancelled.cancelSub?.dispose();
        cancelled.reject(new vscode.CancellationError());
      }
      this.drain();
    }
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.ready) return;
    if (this.worker) {
      // Previous worker crashed — terminate and spawn fresh.
      this.worker.terminate().catch(() => {});
    }
    const workerPath = path.join(__dirname, "worker", "worker.js");
    const worker = this.createWorker(workerPath);
    this.worker = worker;
    this.ready = false;
    this.failed = false;

    worker.on("message", (message: WorkerMessage) => {
      switch (message.type) {
        case "ready":
          this.ready = true;
          break;
        case "progress":
          this.current?.progress?.report({
            message: message.message,
            increment: message.increment,
          });
          break;
        case "log":
          writeHostLog(message.chunk);
          break;
        case "notify":
          void vscode.window.showWarningMessage(message.message);
          break;
        case "done":
          if (this.current?.id === message.id) this.current.resolve();
          break;
        case "error":
          if (this.current?.id === message.id) {
            const err = message.cancelled
              ? new vscode.CancellationError()
              : new Error(message.message);
            if (message.stack && !message.cancelled) err.stack = message.stack;
            this.current.reject(err);
          }
          break;
      }
    });

    worker.on("error", (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error({ event: "worker.crashed", err: e.message }, "Archive worker crashed");
      this.failed = true;
      this.ready = false;
      this.worker = null;
      const cur = this.current;
      this.current = null;
      cur?.reject(new Error(`Archive worker crashed: ${e.message}`));
      this.drain();
    });

    worker.on("exit", (code) => {
      if (this.ready && !this.failed) {
        // Unexpected exit while idle — clear state so next use respawns.
        logger.warn({ event: "worker.exited", code }, "Archive worker exited");
        this.worker = null;
        this.ready = false;
        this.failed = true;
        const cur = this.current;
        this.current = null;
        cur?.reject(new Error(`Archive worker exited with code ${code}`));
        this.drain();
      }
    });

    worker.postMessage({ type: "init", config: currentConfig() });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Archive worker did not become ready in time")),
        30_000,
      );
      const check = (message: WorkerMessage) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          worker.off("message", check);
          resolve();
        } else if (message.type === "error") {
          clearTimeout(timer);
          worker.off("message", check);
          reject(new Error(message.message));
        }
      };
      worker.on("message", check);
    });
  }

  private post(message: unknown): void {
    if (!this.worker) return;
    this.worker.postMessage(message);
  }

  dispose(): void {
    const w = this.worker;
    if (w) {
      try {
        w.postMessage({ type: "shutdown" });
      } catch {
        // worker already gone
      }
      setTimeout(() => w.terminate(), 1000).unref();
      this.worker = null;
      this.ready = false;
    }
    const pending = [...this.queue, this.current].filter((r): r is PendingRequest => !!r);
    for (const request of pending) {
      request.cancelSub?.dispose();
      request.reject(new vscode.CancellationError());
    }
    this.queue = [];
    this.current = null;
  }
}
