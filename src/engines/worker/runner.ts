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
import { dispatchOp } from "./dispatch";
import { writeHostLog, logger } from "../../utils/logger";
import { readEngineConfig } from "../../utils/config";
import {
  WORKER_JS_HEAP_CAP_MB,
  WORKER_POOL_SIZE_DEFAULT,
  WORKER_POOL_SIZE_MAX,
  WORKER_READY_TIMEOUT_MS,
  WORKER_TERMINATE_DELAY_MS,
} from "../../constants";
import type { TokenLike, ProgressLike } from "../../utils/cancellation";

interface PendingRequest {
  id: number;
  op: ArchiveOp;
  payload: RequestPayload;
  progress?: ProgressLike;
  token?: TokenLike;
  cancelSub?: { dispose(): void };
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface ArchiveRunner {
  run(
    op: ArchiveOp,
    payload: RequestPayload,
    progress?: ProgressLike,
    token?: TokenLike,
  ): Promise<unknown>;
  dispose(): void;
}

let nextId = 1;
let _active: ArchiveRunner | null = null;

function readPoolSize(): number {
  const raw = vscode.workspace.getConfiguration("smart-archive").get<number>("workerPoolSize");
  if (typeof raw !== "number" || !Number.isFinite(raw)) return WORKER_POOL_SIZE_DEFAULT;
  return Math.max(WORKER_POOL_SIZE_DEFAULT, Math.min(WORKER_POOL_SIZE_MAX, Math.floor(raw)));
}

function activeRunner(): ArchiveRunner {
  if (!_active) _active = new WorkerThreadRunner(undefined, readPoolSize());
  return _active;
}

/** Replace the active runner (tests force the in-process runner). */
export function setArchiveRunner(runner: ArchiveRunner): void {
  _active?.dispose();
  _active = runner;
}

/**
 * Dispose the active runner and drop it. On the next runArchiveOp a fresh
 * runner (and worker) is created — used on deactivate so a re-activation
 * does not keep running WASM on the host via a stale in-process runner.
 */
export function resetArchiveRunner(): void {
  _active?.dispose();
  _active = null;
}

/** Run a compress/decompress op through the active runner. */
export function runArchiveOp<T = void>(
  op: ArchiveOp,
  payload: RequestPayload,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<T> {
  return activeRunner().run(op, payload, progress, token) as Promise<T>;
}

/**
 * Push the current workspace configuration to a live worker (limits,
 * locale, zstd setting, memory guard). Called on config change so the
 * worker never runs with stale values until its next restart.
 */
export function reconfigureArchiveWorker(): void {
  const runner = _active;
  if (runner instanceof WorkerThreadRunner) runner.reconfigure();
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
  ): Promise<unknown> {
    // Same op → core mapping the worker handler executes (engines/worker/
    // dispatch) — one table, two adapters, so the in-process path can
    // never drift from the worker.
    return dispatchOp(op, payload, progress, token);
  }

  dispose(): void {
    // nothing to dispose
  }
}

interface WorkerSlot {
  worker: Worker | null;
  ready: boolean;
  failed: boolean;
  current: PendingRequest | null;
}

/**
 * Worker-thread runner — a FIFO queue over a pool of worker_threads
 * workers (default pool size 1 = serialized). Each request runs on the
 * first free worker; a crashed worker is replaced on the next use.
 */
export class WorkerThreadRunner implements ArchiveRunner {
  private slots: WorkerSlot[] = [];
  private queue: PendingRequest[] = [];
  private draining = false;
  private config: EngineConfig = readEngineConfig();

  constructor(
    private readonly createWorker: (workerPath: string) => Worker = (p) =>
      new Worker(p, {
        // Wide JS-heap cap as a backstop against JS-level leaks. The WASM
        // memory (VFS) is a WebAssembly.Memory, not part of this heap —
        // it is guarded by the worker-side RSS check (workerMemoryMb).
        resourceLimits: { maxOldGenerationSizeMb: WORKER_JS_HEAP_CAP_MB },
      }),
    private readonly poolSize = WORKER_POOL_SIZE_DEFAULT,
  ) {}

  /**
   * Push the latest workspace config to all live workers. No-op while no
   * worker is running — the next spawn uses fresh config anyway.
   */
  reconfigure(): void {
    this.config = readEngineConfig();
    for (const slot of this.slots) {
      if (slot.worker && slot.ready) {
        this.postTo(slot, { type: "reconfigure", config: this.config });
      }
    }
  }

  run(
    op: ArchiveOp,
    payload: RequestPayload,
    progress?: ProgressLike,
    token?: TokenLike,
  ): Promise<unknown> {
    let resolve!: (value: unknown) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
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
      } else {
        const slot = this.slots.find((s) => s.current === request);
        if (slot) this.postTo(slot, { type: "cancel", id: request.id });
      }
    });
    this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        // Drop queued requests that were cancelled while we were busy.
        while (this.queue.length > 0 && this.queue[0].token?.isCancellationRequested) {
          const cancelled = this.queue.shift()!;
          cancelled.cancelSub?.dispose();
          cancelled.reject(new vscode.CancellationError());
        }
        if (this.queue.length === 0) break;

        // 1) An idle ready slot is the fastest path.
        let slot = this.slots.find((s) => !s.current && s.ready);
        if (slot) {
          this.assign(slot, this.queue.shift()!);
          continue;
        }

        // 2) Rebuild a crashed/dead slot (worker lost its thread).
        const deadSlot = this.slots.find((s) => !s.current && !s.ready);
        if (deadSlot) {
          try {
            await this.ensureSlotReady(deadSlot);
          } catch (err) {
            logger.error(
              {
                event: "worker.spawn.failed",
                err: err instanceof Error ? err.message : String(err),
              },
              "Archive worker failed to start",
            );
            // The spawn may have timed out after creating the thread —
            // reclaim it so it does not leak.
            deadSlot.worker?.terminate().catch(() => {});
            deadSlot.worker = null;
            const failedReq = this.queue.shift();
            failedReq?.cancelSub?.dispose();
            failedReq?.reject(err instanceof Error ? err : new Error(String(err)));
            continue;
          }
          if (this.queue.length === 0) break;
          if (deadSlot.ready) {
            this.assign(deadSlot, this.queue.shift()!);
          }
          continue;
        }

        // 3) Grow the pool up to poolSize.
        if (this.slots.length < this.poolSize) {
          slot = { worker: null, ready: false, failed: false, current: null };
          this.slots.push(slot);
          try {
            await this.ensureSlotReady(slot);
          } catch (err) {
            // Spawn failed (missing bundle / worker startup crash) — fail
            // the queued request and drop the dead slot.
            logger.error(
              {
                event: "worker.spawn.failed",
                err: err instanceof Error ? err.message : String(err),
              },
              "Archive worker failed to start",
            );
            // The spawn may have timed out after creating the thread —
            // reclaim it before dropping the slot.
            slot.worker?.terminate().catch(() => {});
            this.slots.pop();
            const failedReq = this.queue.shift();
            failedReq?.cancelSub?.dispose();
            failedReq?.reject(err instanceof Error ? err : new Error(String(err)));
            continue;
          }
          if (this.queue.length === 0) break;
          if (slot.ready) {
            this.assign(slot, this.queue.shift()!);
          }
          continue;
        }

        // All workers busy — wait for one to free up.
        break;
      }
    } finally {
      this.draining = false;
    }
  }

  private assign(slot: WorkerSlot, request: PendingRequest): void {
    slot.current = request;
    this.postTo(slot, {
      type: "request",
      id: request.id,
      op: request.op,
      payload: request.payload,
    });
    // The request settles when the worker replies done/error (or crashes).
    void request.promise
      .finally(() => {
        request.cancelSub?.dispose();
        if (slot.current === request) slot.current = null;
        this.drain();
      })
      .catch(() => {});
  }

  private async ensureSlotReady(slot: WorkerSlot): Promise<void> {
    if (slot.worker && slot.ready) return;
    if (slot.worker) {
      // Previous worker crashed — terminate and spawn fresh.
      slot.worker.terminate().catch(() => {});
    }
    const workerPath = path.join(__dirname, "worker", "worker.js");
    const worker = this.createWorker(workerPath);
    slot.worker = worker;
    slot.ready = false;
    slot.failed = false;

    worker.on("message", (message: WorkerMessage) => {
      switch (message.type) {
        case "ready":
          slot.ready = true;
          break;
        case "progress":
          slot.current?.progress?.report({
            message: message.message,
            increment: message.increment,
            stage: message.stage,
          });
          break;
        case "log":
          writeHostLog(message.chunk);
          break;
        case "notify":
          void vscode.window.showWarningMessage(message.message);
          break;
        case "done":
          if (slot.current?.id === message.id) slot.current.resolve(message.result);
          break;
        case "error":
          if (slot.current?.id === message.id) {
            const err = message.cancelled
              ? new vscode.CancellationError()
              : new Error(message.message);
            if (message.stack && !message.cancelled) err.stack = message.stack;
            slot.current.reject(err);
          }
          break;
      }
    });

    worker.on("error", (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error({ event: "worker.crashed", err: e.message }, "Archive worker crashed");
      slot.failed = true;
      slot.ready = false;
      slot.worker = null;
      const cur = slot.current;
      slot.current = null;
      cur?.reject(new Error(`Archive worker crashed: ${e.message}`));
      this.drain();
    });

    worker.on("exit", (code) => {
      if (slot.ready && !slot.failed) {
        // Unexpected exit while idle — clear state so next use respawns.
        logger.warn({ event: "worker.exited", code }, "Archive worker exited");
        slot.worker = null;
        slot.ready = false;
        slot.failed = true;
        const cur = slot.current;
        slot.current = null;
        cur?.reject(new Error(`Archive worker exited with code ${code}`));
        this.drain();
      }
    });

    this.config = readEngineConfig();
    worker.postMessage({ type: "init", config: this.config });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Archive worker did not become ready in time"));
      }, WORKER_READY_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", check);
        worker.off("error", onError);
      };
      const check = (message: WorkerMessage) => {
        if (message.type === "ready") {
          cleanup();
          resolve();
        } else if (message.type === "error") {
          cleanup();
          reject(new Error(message.message));
        }
      };
      const onError = (err: unknown) => {
        // Spawn failed (e.g. missing worker bundle) — fail fast instead of
        // waiting out the ready timeout.
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      worker.on("message", check);
      worker.on("error", onError);
    });
  }

  private postTo(slot: WorkerSlot, message: unknown): void {
    if (!slot.worker) return;
    slot.worker.postMessage(message);
  }

  dispose(): void {
    for (const slot of this.slots) {
      const w = slot.worker;
      if (w) {
        try {
          w.postMessage({ type: "shutdown" });
        } catch {
          // worker already gone
        }
        setTimeout(() => w.terminate(), WORKER_TERMINATE_DELAY_MS).unref();
      }
      slot.worker = null;
      slot.ready = false;
    }
    const pending = this.queue.filter((r): r is PendingRequest => !!r);
    for (const slot of this.slots) if (slot.current) pending.push(slot.current);
    for (const request of pending) {
      request.cancelSub?.dispose();
      request.reject(new vscode.CancellationError());
    }
    this.queue = [];
    for (const slot of this.slots) slot.current = null;
  }
}
