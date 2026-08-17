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

export async function isEncrypted(filePath: string): Promise<boolean> {
  const { engine } = selectEngine({ op: "isEncrypted", ext: getFullExt(filePath) });

  if (engine === "system7z") {
    return isEncryptedSystem7z(filePath);
  }

  return runArchiveOp<boolean>("isEncrypted", { inputPath: filePath });
}
