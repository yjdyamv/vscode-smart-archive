/**
 * Archive worker handler — Smart Archiver VSCode Extension
 *
 * Message-loop logic for the archive worker, extracted from the entry
 * (worker.ts) so it can be unit-tested with a fake port. The entry passes
 * the real parentPort; tests pass an in-memory port.
 *
 * @module engines/worker/handler
 */

import type { HostMessage, EngineConfig, RequestMessage } from "./types";
import { dispatchOp } from "./dispatch";
import { applyEngineConfig } from "../engine-config";
import { setLoggerSink } from "../../utils/logger-core";
import { isCancellationError } from "../../utils/cancellation";
import type { TokenLike, ProgressLike, ProgressStage } from "../../utils/cancellation";
import { logger } from "../../utils/logger-core";

export interface WorkerPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: HostMessage) => void): void;
  close(): void;
}

export function serializeWorkerError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) return { message: err.message, name: err.name };
  // Non-Error throws (e.g. emscripten's FS.ErrnoError is a plain object) —
  // String(err) would become "[object Object]" and hide the failure.
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; errno?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof e.name === "string" && e.name) parts.push(e.name);
    if (typeof e.errno === "number") parts.push(`errno=${e.errno}`);
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (parts.length > 0) {
      return { message: parts.join(": "), name: typeof e.name === "string" ? e.name : undefined };
    }
  }
  return { message: String(err) };
}

export function createArchiveWorkerHandler(port: WorkerPort): void {
  const cancelled = new Set<number>();
  let requestChain: Promise<void> = Promise.resolve();

  function post(message: unknown): void {
    port.postMessage(message);
  }

  function applyConfig(config: EngineConfig): void {
    // Same pipeline the host runs at activation / settings change — one
    // interface keeps worker and host engine behaviour in lockstep.
    applyEngineConfig(config, {
      warn: (message) => post({ type: "notify", message }),
    });
  }

  function makeToken(requestId: number): TokenLike {
    return {
      get isCancellationRequested() {
        return cancelled.has(requestId);
      },
      onCancellationRequested(_listener: () => void) {
        // Cancellation arrives as a message while callMain is running; the
        // token is polled at phase boundaries, so a one-shot subscription is
        // unnecessary — the getter above is the source of truth.
        return { dispose() {} };
      },
    };
  }

  function makeProgress(requestId: number): ProgressLike {
    return {
      report(v: { message?: string; increment?: number; stage?: ProgressStage }) {
        post({
          type: "progress",
          id: requestId,
          message: v.message,
          increment: v.increment,
          stage: v.stage,
        });
      },
    };
  }

  async function handleRequest(message: RequestMessage): Promise<void> {
    const { id, op, payload } = message;
    logger.info({ event: "worker.request.start", id, op });
    try {
      const result = await dispatchOp(op, payload, makeProgress(id), makeToken(id));
      post({ type: "done", id, result });
    } catch (err) {
      const serialized = serializeWorkerError(err);
      post({
        type: "error",
        id,
        cancelled: isCancellationError(err),
        message: serialized.message,
        name: serialized.name,
        stack: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      cancelled.delete(id);
    }
  }

  port.on("message", (message: HostMessage) => {
    switch (message.type) {
      case "init":
      case "reconfigure":
        applyConfig(message.config);
        if (message.type === "init") post({ type: "ready" });
        break;
      case "request":
        // Serialize: one operation at a time — matches the host's single
        // worker + FIFO queue design.
        requestChain = requestChain.then(
          () => handleRequest(message),
          () => handleRequest(message),
        );
        break;
      case "cancel":
        cancelled.add(message.id);
        break;
      case "shutdown":
        port.close();
        break;
    }
  });

  // Forward structured logs to the host OutputChannel instead of stderr.
  setLoggerSink((chunk) => {
    post({ type: "log", chunk: chunk.toString() });
  });
}
