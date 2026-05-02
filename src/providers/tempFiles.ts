/**
 * Temp file lifecycle — Smart Archive VSCode Extension
 *
 * Manages preview temp files created when previewing individual archive
 * entries. Files are named by content SHA256 hash so that repeated
 * previews of the same content reuse the same file on disk.
 *
 * Cleanup runs at extension activate (stale from previous session)
 * and deactivate (current session).
 *
 * @module providers/tempFiles
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { logger } from "../utils/logger";

const PREVIEW_TMP_DIR = path.join(os.tmpdir(), "vscode-7z-preview");

let tempCleanupRegistered = false;

function cleanupPreviewTemp(): void {
  try {
    fs.rmSync(PREVIEW_TMP_DIR, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ event: "tempFiles.cleanup.failed", err }, "Failed to clean up temp files");
  }
}

function initTempCleanup(context: vscode.ExtensionContext): void {
  if (tempCleanupRegistered) return;
  tempCleanupRegistered = true;

  try {
    if (fs.existsSync(PREVIEW_TMP_DIR)) {
      cleanupPreviewTemp();
    }
  } catch {
    logger.warn({ event: "tempFiles.initCleanup.failed" }, "Failed to clean up temp directory");
  }

  context.subscriptions.push({
    dispose: () => {
      try {
        cleanupPreviewTemp();
      } catch {
        logger.warn(
          { event: "tempFiles.disposeCleanup.failed" },
          "Failed to clean up temp directory",
        );
      }
    },
  });
}

export { PREVIEW_TMP_DIR, initTempCleanup, cleanupPreviewTemp };
