/**
 * JS7z WASM instance pool — Smart Archive VSCode Extension
 *
 * Maintains a small pool of pre-initialized JS7z WASM instances to avoid
 * repeated WASM initialization overhead across multiple operations.
 * Instances are lazily created on first acquire and reused via acquire/release.
 *
 * @module engines/js7z-pool
 */

import type { JS7zInstance, JS7zFactory } from "../types";
import { JS7z } from "./js7z-factory";
import { logger } from "../utils/logger";

const MAX_IDLE = 2;

let _pool: JS7zInstance[] = [];

export async function acquirePooled(): Promise<JS7zInstance> {
  const cached = _pool.pop();
  if (cached) {
    logger.info({ event: "js7zPool.acquire", source: "cache", remaining: _pool.length });
    return cached;
  }
  logger.info({ event: "js7zPool.acquire", source: "new" });
  return JS7z();
}

export function releasePooled(instance: JS7zInstance): void {
  if (_pool.length >= MAX_IDLE) {
    destroyInstance(instance);
    return;
  }
  logger.info({ event: "js7zPool.release", poolSize: _pool.length + 1 });
  _pool.push(instance);
}

export function drainPool(): void {
  for (const instance of _pool) {
    destroyInstance(instance);
  }
  _pool = [];
  logger.info({ event: "js7zPool.drained" });
}

function destroyInstance(instance: JS7zInstance): void {
  try {
    if (typeof instance.destroy === "function") instance.destroy();
    else if (typeof (instance as any)._cleanup === "function") (instance as any)._cleanup();
  } catch (err) {
    logger.warn({ event: "js7zPool.destroy.failed", err }, "Failed to destroy pooled JS7z instance");
  }
}
