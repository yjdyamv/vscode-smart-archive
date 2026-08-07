/**
 * Host config bridge — Smart Archive VSCode Extension
 *
 * Reads vscode workspace configuration and injects the values the
 * vscode-free engine layer needs (size limits, locale, zstd setting).
 * Call at activation and on configuration change.
 *
 * @module utils/config
 */

import * as vscode from "vscode";
import { parseSize, setSecurityLimits } from "./security";
import {
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_TOTAL_SIZE,
  WORKER_MEMORY_LIMIT_DEFAULT_MB,
} from "../constants";
import { setLocale } from "../i18n";
import { setZstdConfig } from "../engines/zstd-codec";
import { setBrotliConfig } from "../engines/brotli-codec";
import { setRar5Config, type Rar5Backend } from "../engines/rar5-engine";
import { setSnappyConfig, type SnappyBackend } from "../engines/snappy-codec";
import { logger, setHistoryBudget } from "./logger";
import type { EngineConfig } from "../engines/worker/types";
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
  const config = vscode.workspace.getConfiguration("smart-archive");
  const memMb = config.get<number>("workerMemoryMb", WORKER_MEMORY_LIMIT_DEFAULT_MB);
  return {
    locale: vscode.env.language,
    limits: {
      maxFileSize: parseSize(config.get<string | number>("maxFileSize"), DEFAULT_MAX_FILE_SIZE),
      maxTotalSize: parseSize(config.get<string | number>("maxTotalSize"), DEFAULT_MAX_TOTAL_SIZE),
    },
    useSystemZstd: config.get<string>("useSystemZstd", "auto"),
    brotliBackend: config.get<string>("brotliBackend", "node"),
    rar5Backend: validBackend(config.get<string>("rar5Backend", "auto")),
    snappyBackend: validBackend(config.get<string>("snappyBackend", "auto")),
    compressionLevel: config.get<number>("defaultCompressionLevel", 5),
    workerMemoryMb:
      typeof memMb === "number" && Number.isFinite(memMb)
        ? Math.max(0, Math.floor(memMb))
        : WORKER_MEMORY_LIMIT_DEFAULT_MB,
    logLevel: validLogLevel(config.get<string>("logLevel", "info")),
  };
}

function validBackend(raw: string): Rar5Backend | SnappyBackend {
  return raw === "native" || raw === "wasm" ? raw : "auto";
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
  setLocale(config.locale);

  setSecurityLimits(config.limits);
  logger.setLevel(config.logLevel ?? "info");
  setHistoryBudget(readLogHistoryBudget(vscode.workspace.getConfiguration("smart-archive")));

  setZstdConfig({
    useSystemZstd: config.useSystemZstd,
    warn: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
  setBrotliConfig({
    backend: config.brotliBackend,
    warn: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
  setRar5Config({ backend: config.rar5Backend });
  setSnappyConfig({ backend: config.snappyBackend });
}

/** Read and clamp the logHistoryBytes setting into its documented bounds. */
function readLogHistoryBudget(config: vscode.WorkspaceConfiguration): number {
  const raw = config.get<number>("logHistoryBytes", DEFAULT_LOG_HISTORY_BYTES);
  if (!Number.isFinite(raw)) return DEFAULT_LOG_HISTORY_BYTES;
  return Math.min(MAX_LOG_HISTORY_BYTES, Math.max(MIN_LOG_HISTORY_BYTES, Math.floor(raw)));
}
