/**
 * Archive worker handler — Smart Archive VSCode Extension
 *
 * Message-loop logic for the archive worker, extracted from the entry
 * (worker.ts) so it can be unit-tested with a fake port. The entry passes
 * the real parentPort; tests pass an in-memory port.
 *
 * @module engines/worker/handler
 */

import type {
  HostMessage,
  EngineConfig,
  RequestMessage,
  CompressPayload,
  DecompressPayload,
} from "./types";
import { compressWith7z as compressCore } from "../js7z-compress-core";
import { decompressWith7z as decompressCore } from "../js7z-decompress-core";
import { setLocale } from "../../i18n";
import { setSecurityLimits } from "../../utils/security";
import { setZstdConfig } from "../zstd-codec";
import { setLoggerSink } from "../../utils/logger-core";
import { isCancellationError } from "../../utils/cancellation";
import type { TokenLike, ProgressLike } from "../../utils/cancellation";
import { logger } from "../../utils/logger-core";

export interface WorkerPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: HostMessage) => void): void;
  close(): void;
}

export function createArchiveWorkerHandler(port: WorkerPort): void {
  const cancelled = new Set<number>();
  let requestChain: Promise<void> = Promise.resolve();

  function post(message: unknown): void {
    port.postMessage(message);
  }

  function applyConfig(config: EngineConfig): void {
    setLocale(config.locale ?? "en");
    setSecurityLimits(config.limits ?? {});
    setZstdConfig({
      useSystemZstd: config.useSystemZstd ?? "auto",
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
      report(v: { message?: string; increment?: number }) {
        post({ type: "progress", id: requestId, message: v.message, increment: v.increment });
      },
    };
  }

  async function handleRequest(message: RequestMessage): Promise<void> {
    const { id, op, payload } = message;
    logger.info({ event: "worker.request.start", id, op });
    try {
      if (op === "compress") {
        const p = payload as CompressPayload;
        await compressCore(p.options, makeProgress(id), makeToken(id), p.excludePatterns);
      } else {
        const p = payload as DecompressPayload;
        await decompressCore(p.options, makeProgress(id), makeToken(id));
      }
      post({ type: "done", id });
    } catch (err) {
      post({
        type: "error",
        id,
        cancelled: isCancellationError(err),
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
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
