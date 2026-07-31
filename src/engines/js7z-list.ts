/**
 * js7z list & inspect dispatcher — Smart Archive VSCode Extension
 *
 * Host-side entry point for archive listing / encryption detection.
 * Keeps the original listFiles/isEncrypted signatures; the WASM work
 * runs in the worker thread (js7z-list-core). The system-7z fast path
 * (child process) stays on the host.
 *
 * @module engines/js7z-list
 */

import type { ListEntry } from "./fileListing-core";
import { runArchiveOp } from "./worker/runner";
import { hasSystem7z, listWithSystem7z, isEncryptedSystem7z } from "./system7z";
import { logger } from "../utils/logger";

export async function listFiles(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<ListEntry[]> {
  logger.debug({ event: "listFiles.start", filePath, hasPassword: !!password });

  if (hasSystem7z() && !data) {
    return listWithSystem7z(filePath, password);
  }

  return runArchiveOp<ListEntry[]>("list", { inputPath: filePath, password, data });
}

export async function isEncrypted(filePath: string): Promise<boolean> {
  if (hasSystem7z()) {
    return isEncryptedSystem7z(filePath);
  }

  return runArchiveOp<boolean>("isEncrypted", { inputPath: filePath });
}
