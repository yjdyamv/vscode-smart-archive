/**
 * Host config bridge — Smart Archiver VSCode Extension
 *
 * Reads vscode workspace configuration and applies it to the vscode-free
 * engine layer via engines/engine-config (applyEngineConfig). The worker
 * receives the same EngineConfig over init/reconfigure messages, so host
 * and worker share one configuration pipeline.
 * Call at activation and on configuration change.
 *
 * @module utils/config
 */

import * as vscode from "vscode";
import { parseSize } from "./security";
import { DEFAULT_MAX_ARCHIVE_SIZE, DEFAULT_MAX_EXTRACT_TOTAL_SIZE } from "../constants";
import { applyEngineConfig, DEFAULT_ENGINE_CONFIG } from "../engines/engine-config";
import { logger, setHistoryBudget } from "./logger";
import type { EngineConfig } from "../engines/worker/types";
import type { Rar5Backend } from "../engines/rar5-engine";
import type { SnappyBackend } from "../engines/snappy-codec";
import {
  DEFAULT_LOG_HISTORY_BYTES,
  MAX_LOG_HISTORY_BYTES,
  MIN_LOG_HISTORY_BYTES,
} from "../constants";

/**
 * Read the engine-relevant configuration from vscode.
 * Shared by the host bridge (applyHostConfig) and the worker runner
 * (worker init/reconfigure) so the values never drift apart.
 */
export function readEngineConfig(): EngineConfig {
  const config = vscode.workspace.getConfiguration("smart-archiver");
  const memMb = config.get<number>("workerMemoryMb", DEFAULT_ENGINE_CONFIG.workerMemoryMb);
  return {
    locale: vscode.env.language,
    limits: {
      maxArchiveSize: parseSize(
        config.get<string | number>("maxArchiveSize"),
        DEFAULT_MAX_ARCHIVE_SIZE,
      ),
      maxExtractTotalSize: parseSize(
        config.get<string | number>("maxExtractTotalSize"),
        DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
      ),
    },
    sevenZBackend: validEngineBackend(
      config.get("backend.7z", DEFAULT_ENGINE_CONFIG.sevenZBackend),
      ["native", "bundled", "wasm"],
    ),
    zstdBackend: validEngineBackend(config.get("backend.zstd", DEFAULT_ENGINE_CONFIG.zstdBackend), [
      "native",
      "bundled",
      "wasm",
    ]),
    brotliBackend: validEngineBackend(
      config.get("backend.brotli", DEFAULT_ENGINE_CONFIG.brotliBackend),
      ["native", "bundled", "wasm"],
    ),
    lz4Backend: validEngineBackend(config.get("backend.lz4", DEFAULT_ENGINE_CONFIG.lz4Backend), [
      "bundled",
      "wasm",
    ]),
    rar5Backend: validBackend(config.get("backend.rar", DEFAULT_ENGINE_CONFIG.rar5Backend)),
    snappyBackend: validBackend(config.get("backend.snappy", DEFAULT_ENGINE_CONFIG.snappyBackend)),
    compressionLevel: config.get("defaultCompressionLevel", DEFAULT_ENGINE_CONFIG.compressionLevel),
    workerMemoryMb:
      typeof memMb === "number" && Number.isFinite(memMb)
        ? Math.max(0, Math.floor(memMb))
        : DEFAULT_ENGINE_CONFIG.workerMemoryMb,
    logLevel: validLogLevel(config.get("logLevel", DEFAULT_ENGINE_CONFIG.logLevel)),
  };
}

function validBackend(raw: string): Rar5Backend | SnappyBackend {
  return raw === "native" || raw === "wasm" ? raw : "auto";
}

/** Validate a unified engine-backend value against its allowed native tiers. */
function validEngineBackend<T extends "native" | "bundled" | "wasm">(
  raw: string,
  nativeTiers: readonly T[],
): T | "auto" {
  return (raw === "wasm" || nativeTiers.includes(raw as T) ? raw : "auto") as T | "auto";
}

function validLogLevel(raw: string): "error" | "warn" | "info" | "debug" {
  return raw === "error" || raw === "warn" || raw === "debug" ? raw : "info";
}

/**
 * Push the current workspace configuration into the vscode-free engine
 * layer. Idempotent — safe to call at activation and on every
 * onDidChangeConfiguration event.
 */
export function applyHostConfig(): void {
  const config = readEngineConfig();
  applyEngineConfig(config, {
    warn: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
  // Re-render the output panel at the new level (engine-config already set
  // the underlying pino level; the host wrapper additionally rebuilds the
  // panel buffer from history).
  logger.setLevel(config.logLevel ?? DEFAULT_ENGINE_CONFIG.logLevel);
  setHistoryBudget(readLogHistoryBudget(vscode.workspace.getConfiguration("smart-archiver")));
}

/** Read and clamp the logHistoryBytes setting into its documented bounds. */
function readLogHistoryBudget(config: vscode.WorkspaceConfiguration): number {
  const raw = config.get<number>("logHistoryBytes", DEFAULT_LOG_HISTORY_BYTES);
  if (!Number.isFinite(raw)) return DEFAULT_LOG_HISTORY_BYTES;
  return Math.min(MAX_LOG_HISTORY_BYTES, Math.max(MIN_LOG_HISTORY_BYTES, Math.floor(raw)));
}
