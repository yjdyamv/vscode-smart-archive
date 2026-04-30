/**
 * Temp file lifecycle — Smart Archive VSCode Extension
 *
 * Manages preview temp files created when previewing individual archive
 * entries. Handles cleanup from previous sessions, tab-close tracking,
 * and final cleanup on extension deactivation.
 *
 * @module providers/tempFiles
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const PREVIEW_TMP_DIR = path.join(
  fs.existsSync(process.env.TEMP || "/tmp") ? process.env.TEMP || "/tmp" : "/tmp",
  "vscode-7z-preview",
);

const trackedTempFiles = new Set<string>();
let tempCleanupRegistered = false;

function initTempCleanup(context: vscode.ExtensionContext): void {
  if (tempCleanupRegistered) return;
  tempCleanupRegistered = true;

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

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        const uri =
          (tab.input as vscode.TabInputText)?.uri ??
          (tab.input as vscode.TabInputCustom)?.uri ??
          (tab.input as any)?.uri;
        if (uri instanceof vscode.Uri && trackedTempFiles.has(uri.fsPath)) {
          try {
            fs.unlinkSync(uri.fsPath);
          } catch {
            /* ignore */
          }
          trackedTempFiles.delete(uri.fsPath);
        }
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      for (const p of trackedTempFiles) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
      trackedTempFiles.clear();
    },
  });
}

export { PREVIEW_TMP_DIR, trackedTempFiles, initTempCleanup };
