/**
 * JS7z WASM lifecycle — Smart Archiver VSCode Extension
 *
 * The ONLY JS7z cleanup function. With the shared 7zz instance the
 * destroy/_cleanup hooks are no-ops (see engines/js7z-factory); keeping the
 * call site uniform lets callers dispose without leaking a second instance.
 *
 * @module engines/js7z-lifecycle
 */

import type { JS7zInstance } from "../types";
import { logger } from "../utils/logger-core";

/**
 * Canonical cleanup for a JS7z WASM instance.
 * All code must call this to release every JS7z instance.
 */
export function disposeJS7z(instance: JS7zInstance): void {
  try {
    if (typeof instance.destroy === "function") instance.destroy();
    else if (typeof instance._cleanup === "function") instance._cleanup();
  } catch (err) {
    logger.warn({ event: "js7z.destroy.failed", err }, "Failed to dispose JS7z instance");
  }
}
