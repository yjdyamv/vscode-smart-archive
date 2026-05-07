/**
 * File system utilities — 7z VSCode Extension
 *
 * Provides bidirectional copy between the local Node.js file system
 * and the Emscripten virtual file system used by js7z-tools.
 *
 * IMPORTANT: All virtual FS paths must use forward slashes (/),
 * even on Windows. path.join() MUST NOT be used for FS paths —
 * use string concatenation or path.posix.join instead.
 *
 * @module utils/fs
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { JS7zInstance } from "../types";
import { safeJoinPath, checkFileSize, checkTotalSize } from "./security";
import { getFullExt } from "../constants";
import { logger } from "./logger";
import { streamToVFS } from "../engines/vfs-io";

/**
 * Generate a collision-free output path.
 * If the target exists, appends _1, _2, ... before the extension.
 *
 * @param inputPath - Original file path
 * @param extension - Extension to append (e.g. '7z', 'extracted')
 * @returns A unique output path guaranteed not to exist
 *
 * @example
 *   getOutputPath('/data/archive.7z', 'extracted')
 *   // → '/data/archive.extracted' (if available)
 *   // → '/data/archive_1.extracted' (if collision)
 */
export function getOutputPath(inputPath: string, extension: string): string {
  const dir = path.dirname(inputPath);
  const fullExt = getFullExt(inputPath);
  const base = path.basename(inputPath, fullExt);
  const name = `${base}.${extension}`;
  let output = path.join(dir, name);
  let counter = 1;
  while (fs.existsSync(output)) {
    if (counter > 999) {
      throw new Error(`Failed to find unique output path after ${counter} attempts`);
    }
    output = path.join(dir, `${base}_${counter}.${extension}`);
    counter++;
  }
  return output;
}

/**
 * Recursively copy a local directory into the JS7z virtual file system.
 *
 * @param js7z - JS7z instance
 * @param localDir - Local directory path (native OS format)
 * @param fsDir - Target path in the virtual FS (Unix-style, e.g. '/in/mydir')
 */
export function copyDirToFS(
  js7z: JS7zInstance,
  localDir: string,
  fsDir: string,
  token?: vscode.CancellationToken,
): void {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    const localEntry = path.join(localDir, entry.name);
    const fsEntry = `${fsDir}/${entry.name}`;
    if (entry.isDirectory()) {
      js7z.FS.mkdir(fsEntry);
      copyDirToFS(js7z, localEntry, fsEntry, token);
    } else {
      streamToVFS(js7z, localEntry, fsEntry);
    }
  }
}

export const MAX_DIR_DEPTH = 100;

/**
 * Recursively copy a directory from the JS7z virtual FS to the local file system.
 *
 * @param js7z - JS7z instance
 * @param fsDir - Source directory in the virtual FS (Unix-style)
 * @param localDir - Target local directory (native OS format)
 */
export function copyDirFromFS(
  js7z: JS7zInstance,
  fsDir: string,
  localDir: string,
  token?: vscode.CancellationToken,
): number {
  return _copyDirFromFS(js7z, fsDir, localDir, 0, 0, token);
}

function _copyDirFromFS(
  js7z: JS7zInstance,
  fsDir: string,
  localDir: string,
  totalSize: number,
  depth: number,
  token?: vscode.CancellationToken,
): number {
  if (depth > MAX_DIR_DEPTH) {
    logger.warn(
      { event: "fs.maxDepth.reached", depth },
      "Max directory depth reached, skipping deeper entries",
    );
    return totalSize;
  }
  const entries = js7z.FS.readdir(fsDir);
  for (const entry of entries) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    if (entry === "." || entry === "..") continue;

    // Skip internal .smartarchive marker files used to preserve empty folders
    if (entry === ".smartarchive") {
      logger.debug({ event: "fs.skipSmartarchive" }, "Skipped internal .smartarchive marker");
      continue;
    }

    // Reject entries with embedded path separators or null bytes —
    // these indicate a malicious archive attempting path traversal
    if (entry.includes("/") || entry.includes("\\") || entry.includes("\0")) {
      logger.warn({ event: "fs.pathTraversal", entry }, "Path traversal blocked");
      continue;
    }

    const fsEntry = path.posix.join(fsDir, entry);
    const localEntry = safeJoinPath(localDir, entry);

    // Try stat-based copy first (handles directories via recursion).
    // If stat fails (e.g. the entry is a symlink that Emscripten FS
    // reports as a regular file but can't stat), fall back to reading
    // as a raw file — this covers edge cases with certain archive formats.
    let stat: { mode: number; size: number } | undefined;
    try {
      stat = js7z.FS.stat(fsEntry);
    } catch {
      logger.warn(
        { event: "copyDirFromFS.stat.failed" },
        "Failed to stat virtual FS entry, falling back to raw read",
      );
    }

    if (stat && js7z.FS.isDir(stat.mode)) {
      fs.mkdirSync(localEntry, { recursive: true });
      totalSize = _copyDirFromFS(js7z, fsEntry, localEntry, totalSize, depth + 1, token);
    } else {
      // Read the file data from VFS
      const data = js7z.FS.readFile(fsEntry, { encoding: "binary" });
      if (stat) checkFileSize(stat.size);
      checkFileSize(data.byteLength);
      totalSize = checkTotalSize(totalSize, data.byteLength);
      // Write errors propagate to caller — silent data loss is worse
      // than a reported failure
      fs.writeFileSync(localEntry, Buffer.from(data));
    }
  }
  return totalSize;
}
