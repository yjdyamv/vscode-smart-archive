/**
 * Engine configuration — Smart Archive VSCode Extension
 *
 * Single entry point for pushing workspace configuration into the
 * vscode-free engine layer. Both the extension host (at activation and on
 * settings change) and the worker thread (init/reconfigure messages) call
 * the same applyEngineConfig — one interface, one default source, so the
 * two sides can never drift apart.
 *
 * The individual codec/security injectors (setZstdConfig, setSecurityLimits,
 * …) are internal seams of this module's implementation, not part of its
 * interface. Add a setting by extending EngineConfig and this function —
 * nothing else.
 *
 * Vscode-free: the host supplies the user-facing warning hook (deps.warn →
 * vscode.window.showWarningMessage); the worker forwards it as a notify
 * message.
 *
 * @module engines/engine-config
 */

import type { EngineConfig } from "./worker/types";
import { setLocale } from "../i18n";
import { setSecurityLimits } from "../utils/security";
import { logger } from "../utils/logger-core";
import { setZstdConfig, resetZstdDetectionCache } from "./zstd-codec";
import { setBrotliConfig } from "./brotli-codec";
import { setLz4Config } from "./lz4-codec";
import { setRar5Config, resetRar5BindingCache } from "./rar5-engine";
import { setSnappyConfig, resetSnappyBindingCache } from "./snappy-codec";
import { setModifyConfig } from "./modify-core";
import { setWorkerMemoryLimitMb } from "./worker/memory-guard";
import {
  DEFAULT_COMPRESSION_LEVEL,
  DEFAULT_MAX_ARCHIVE_SIZE,
  DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
  WORKER_MEMORY_LIMIT_DEFAULT_MB,
} from "../constants";

/** Fallback values for every EngineConfig field — single source of truth.
 *  package.json supplies the same defaults to the settings UI; keep the
 *  two in sync (a consistency test guards drift). */
export const DEFAULT_ENGINE_CONFIG: Required<EngineConfig> = {
  locale: "en",
  limits: {
    maxArchiveSize: DEFAULT_MAX_ARCHIVE_SIZE,
    maxExtractTotalSize: DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
  },
  sevenZBackend: "auto",
  zstdBackend: "auto",
  brotliBackend: "auto",
  lz4Backend: "auto",
  rar5Backend: "auto",
  snappyBackend: "auto",
  compressionLevel: DEFAULT_COMPRESSION_LEVEL,
  workerMemoryMb: WORKER_MEMORY_LIMIT_DEFAULT_MB,
  logLevel: "info",
};

/** Host/worker-specific callbacks the engine layer cannot provide itself. */
export interface EngineConfigDeps {
  /** Surface a non-fatal warning to the user. */
  warn: (message: string) => void;
}

/**
 * Push an EngineConfig (partial or complete) into the engine layer.
 * Idempotent — safe at activation, on every settings change, and at each
 * worker init/reconfigure. Missing fields fall back to
 * DEFAULT_ENGINE_CONFIG. Re-evaluates cached backend/binding decisions so a
 * settings change never serves stale engine behaviour.
 */
export function applyEngineConfig(config: EngineConfig, deps: EngineConfigDeps): void {
  const cfg = {
    ...DEFAULT_ENGINE_CONFIG,
    ...config,
    limits: { ...DEFAULT_ENGINE_CONFIG.limits, ...config.limits },
  } as Required<EngineConfig>;

  setLocale(cfg.locale);
  setSecurityLimits(cfg.limits);
  logger.setLevel(cfg.logLevel);

  setZstdConfig({ zstdBackend: cfg.zstdBackend, warn: deps.warn });
  setBrotliConfig({ backend: cfg.brotliBackend, warn: deps.warn });
  setLz4Config({ backend: cfg.lz4Backend });
  setRar5Config({ backend: cfg.rar5Backend });
  setSnappyConfig({ backend: cfg.snappyBackend });
  setModifyConfig({ compressionLevel: cfg.compressionLevel });
  setWorkerMemoryLimitMb(cfg.workerMemoryMb);

  resetZstdDetectionCache();
  resetRar5BindingCache();
  resetSnappyBindingCache();
}
