/**
 * JS7z WASM lifecycle — Smart Archive VSCode Extension
 *
 * The ONLY JS7z cleanup function. Always frees the WASM heap via
 * destroy / _cleanup.
 *
 * @module engines/js7z-pool
 */

import type { JS7zInstance } from "../types";
import { logger } from "../utils/logger";

/**
 * Canonical cleanup for a JS7z WASM instance.
 * All code must call this to release every JS7z instance.
 */
export function disposeJS7z(instance: JS7zInstance): void {
  try {
    if (typeof instance.destroy === "function") instance.destroy();
    else if (typeof (instance as any)._cleanup === "function") (instance as any)._cleanup();
  } catch (err) {
    logger.warn({ event: "js7z.destroy.failed", err }, "Failed to dispose JS7z instance");
  }
}
