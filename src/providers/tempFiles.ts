/**
 * Temp file lifecycle — Smart Archiver VSCode Extension
 *
 * Manages preview temp files created when previewing individual archive
 * entries. Uses per-session unpredictable temp directories to prevent
 * local symlink attacks and TOCTOU races.
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
import { secureRmDir, secureUnlink } from "../utils/fs";

const PREVIEW_TMP_PREFIX = path.join(os.tmpdir(), "vscode-7z-preview-");
let PREVIEW_TMP_DIR = "";

let tempCleanupRegistered = false;

/**
 * Register a listener that cleans up a specific preview temp file when
 * the VS Code text document showing it is closed.
 */
export function registerPreviewCleanup(tmpPath: string, docUri: vscode.Uri): vscode.Disposable {
  return vscode.workspace.onDidCloseTextDocument((closed) => {
    if (closed.uri.toString() === docUri.toString()) {
      try {
        if (fs.existsSync(tmpPath)) secureUnlink(tmpPath);
        logger.info({ event: "tempFiles.preview.closed", tmpPath });
      } catch (err) {
        logger.warn({ event: "tempFiles.preview.cleanupFailed", tmpPath, err });
      }
    }
  });
}

function getPreviewTmpDir(): string {
  if (!PREVIEW_TMP_DIR) {
    PREVIEW_TMP_DIR = fs.mkdtempSync(PREVIEW_TMP_PREFIX);
    fs.chmodSync(PREVIEW_TMP_DIR, 0o700);
  }
  return PREVIEW_TMP_DIR;
}

function cleanupPreviewTemp(): void {
  if (!PREVIEW_TMP_DIR) return;
  try {
    // The session temp dir holds decrypted previews — wipe the bytes
    // (secureUnlink) before removing the tree.
    secureRmDir(PREVIEW_TMP_DIR);
  } catch (err) {
    logger.warn({ event: "tempFiles.cleanup.failed", err }, "Failed to clean up temp files");
  }
}

function initTempCleanup(context: vscode.ExtensionContext): void {
  if (tempCleanupRegistered) return;
  tempCleanupRegistered = true;

  const previewDir = path.join(os.tmpdir(), "vscode-7z-preview");
  try {
    if (fs.existsSync(previewDir)) {
      secureRmDir(previewDir);
    }
  } catch {
    logger.warn(
      { event: "tempFiles.initCleanup.deprecated" },
      "Failed to clean up old style temp dir",
    );
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

const MAX_PREVIEW_FILES = 100;

function pruneOldPreviews(): void {
  const dir = PREVIEW_TMP_DIR;
  if (!dir || !fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    if (files.length <= MAX_PREVIEW_FILES) return;

    const withMtime = files
      .map((e) => ({
        name: e.name,
        mtime: fs.statSync(path.join(dir, e.name)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime);

    let pruned = 0;
    while (withMtime.length > MAX_PREVIEW_FILES) {
      const oldest = withMtime.shift()!;
      try {
        secureUnlink(path.join(dir, oldest.name));
        pruned++;
      } catch {
        logger.warn(
          { event: "tempFiles.prune.failed", file: oldest.name },
          "Failed to remove old preview temp file",
        );
      }
    }
    if (pruned > 0) {
      logger.info(
        { event: "tempFiles.pruned", pruned, remaining: withMtime.length },
        `Pruned ${pruned} old preview temp file(s), ${withMtime.length} remaining`,
      );
    }
  } catch (err) {
    logger.warn({ event: "tempFiles.prune.failed", err }, "Failed to prune preview temp files");
  }
}

export { getPreviewTmpDir, initTempCleanup, cleanupPreviewTemp, pruneOldPreviews };
