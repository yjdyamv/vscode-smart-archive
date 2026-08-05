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
import { fetchFileListCore } from "../fileListing-core";
import { isEncryptedWasm } from "../js7z-list-core";
import {
  addToArchiveCore,
  deleteFromArchiveCore,
  renameInArchiveCore,
  createFolderInArchiveCore,
  previewFileCore,
  testArchiveCore,
  setModifyConfig,
} from "../modify-core";
import { extractSelectedCore } from "../extract-core";
import { unwrapInnerTar } from "../js7z-decompress-core";
import type { ModifyPayload } from "./types";
import { setLocale } from "../../i18n";
import { WORKER_MEMORY_LIMIT_DEFAULT_MB } from "../../constants";
import { setSecurityLimits } from "../../utils/security";
import { setZstdConfig, resetZstdDetectionCache } from "../zstd-codec";
import { setLoggerSink } from "../../utils/logger-core";
import { setWorkerMemoryLimitMb } from "./memory-guard";
import { isCancellationError } from "../../utils/cancellation";
import type { TokenLike, ProgressLike, ProgressStage } from "../../utils/cancellation";
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
    // A setting change may flip the system-zstd decision — drop the cached
    // detection result so the next zstd op re-detects.
    resetZstdDetectionCache();
    setWorkerMemoryLimitMb(config.workerMemoryMb ?? WORKER_MEMORY_LIMIT_DEFAULT_MB);
    setModifyConfig({ compressionLevel: config.compressionLevel ?? 5 });
    logger.setLevel(config.logLevel ?? "info");
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
      let result: unknown;
      if (op === "compress") {
        const p = payload as CompressPayload;
        await compressCore(p.options, makeProgress(id), makeToken(id), p.excludePatterns);
      } else if (op === "decompress") {
        const p = payload as DecompressPayload;
        await decompressCore(p.options, makeProgress(id), makeToken(id));
      } else if (op === "list") {
        const p = payload as { inputPath: string; password?: string; data?: Uint8Array };
        result = await fetchFileListCore(p.inputPath, p.password ?? "", p.data);
      } else if (op === "isEncrypted") {
        const p = payload as { inputPath: string };
        result = await isEncryptedWasm(p.inputPath);
      } else if (op === "unwrap") {
        const p = payload as { outputDir: string };
        await unwrapInnerTar(p.outputDir, makeProgress(id), makeToken(id));
      } else if (op === "modify") {
        const p = payload as ModifyPayload;
        const token = makeToken(id);
        switch (p.action) {
          case "add":
            await addToArchiveCore(
              p.archivePath,
              p.localPaths,
              p.targetDir,
              p.password,
              p.excludePatterns,
              token,
            );
            break;
          case "delete":
            await deleteFromArchiveCore(p.archivePath, p.paths, p.password, token);
            break;
          case "rename":
            await renameInArchiveCore(p.archivePath, p.oldPath, p.newPath, p.password, token);
            break;
          case "createFolder":
            await createFolderInArchiveCore(
              p.archivePath,
              p.targetDir,
              p.folderName,
              p.password,
              token,
            );
            break;
          case "preview":
            await previewFileCore(p.archivePath, p.filePath, p.password, p.outputPath);
            break;
          case "test":
            result = await testArchiveCore(p.archivePath, p.password);
            break;
          case "extract":
            await extractSelectedCore(
              p.archivePath,
              p.paths,
              p.password,
              p.flat,
              p.outputDir,
              p.excludes,
              token,
            );
            break;
        }
      }
      post({ type: "done", id, result });
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
