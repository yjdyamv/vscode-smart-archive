/**
 * js7z list & inspect dispatcher — Smart Archiver VSCode Extension
 *
 * Host-side entry point for archive listing / encryption detection.
 * Keeps the original isEncrypted signature; the WASM work runs in the
 * worker thread (js7z-list-core). The system-7z fast path (child
 * process) stays on the host.
 *
 * @module engines/js7z-list
 */

import { runArchiveOp } from "./worker/runner";
import { isEncryptedSystem7z } from "./system7z";
import { selectEngine } from "./select-engine";
import { getFullExt } from "../constants";
import { logger } from "../utils/logger";

export async function isEncrypted(filePath: string): Promise<boolean> {
  const { engine } = selectEngine({ op: "isEncrypted", ext: getFullExt(filePath) });

  if (engine === "system7z") {
    try {
      return await isEncryptedSystem7z(filePath);
    } catch (err) {
      // The probe could not run at all (no format-capable binary resolved for
      // this extension). Throwing here is what makes the viewer treat a
      // perfectly readable archive as encrypted and demand a password, so
      // fall through to the WASM probe, which answers honestly.
      logger.warn(
        { event: "isEncrypted.system7z.failed", err, filePath },
        "System 7z encryption probe unavailable, falling back to WASM",
      );
    }
  }

  return runArchiveOp<boolean>("isEncrypted", { inputPath: filePath });
}
