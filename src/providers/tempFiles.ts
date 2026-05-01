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

const PREVIEW_TMP_DIR = path.join(os.tmpdir(), "vscode-7z-preview");

let tempCleanupRegistered = false;

function cleanupPreviewTemp(): void {
  try {
    if (fs.existsSync(PREVIEW_TMP_DIR)) {
      for (const f of fs.readdirSync(PREVIEW_TMP_DIR)) {
        try {
          fs.unlinkSync(path.join(PREVIEW_TMP_DIR, f));
        } catch {
          /* stale */
        }
      }
    }
  } catch {
    /* best-effort */
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
    /* best-effort */
  }

  context.subscriptions.push({
    dispose: () => {
      try {
        cleanupPreviewTemp();
      } catch {
        /* best-effort */
      }
    },
  });
}

export { PREVIEW_TMP_DIR, initTempCleanup, cleanupPreviewTemp };
