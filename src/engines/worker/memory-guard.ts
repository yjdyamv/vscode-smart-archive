/**
 * Worker memory guard — Smart Archive VSCode Extension
 *
 * RSS-based safety net for the archive worker. The WASM memory (VFS) is a
 * WebAssembly.Memory and is invisible to V8 heap caps, so instead of
 * resourceLimits we poll process RSS at phase boundaries and fail with a
 * friendly error when the configured ceiling is exceeded.
 *
 * Vscode-free — the threshold arrives via the worker init/reconfigure
 * message (EngineConfig.workerMemoryMb).
 *
 * @module engines/worker/memory-guard
 */

import { t } from "../../i18n";
import { WORKER_MEMORY_LIMIT_DEFAULT_MB } from "../../constants";

let _limitMb = WORKER_MEMORY_LIMIT_DEFAULT_MB;

/** Set the RSS ceiling in MiB (0 disables the guard). */
export function setWorkerMemoryLimitMb(mb: number): void {
  _limitMb = mb;
}

/**
 * Throw a friendly error when the worker RSS exceeds the configured limit.
 * Called between heavy phases (7z progress ticks, VFS chunk copies) — cheap
 * enough to run frequently, never inside a tight hot loop.
 */
export function checkWorkerMemory(): void {
  if (_limitMb <= 0) return;
  const rssMb = process.memoryUsage().rss / (1024 * 1024);
  if (rssMb > _limitMb) {
    throw new Error(t("worker.memoryLimit", String(_limitMb)));
  }
}
