/**
 * js7z list & inspect dispatcher — Smart Archive VSCode Extension
 *
 * Host-side entry point for archive listing / encryption detection.
 * Keeps the original isEncrypted signature; the WASM work runs in the
 * worker thread (js7z-list-core). The system-7z fast path (child
 * process) stays on the host.
 *
 * @module engines/js7z-list
 */

import { runArchiveOp } from "./worker/runner";
import { hasSystem7z, isEncryptedSystem7z } from "./system7z";

export async function isEncrypted(filePath: string): Promise<boolean> {
  if (hasSystem7z()) {
    return isEncryptedSystem7z(filePath);
  }

  return runArchiveOp<boolean>("isEncrypted", { inputPath: filePath });
}
