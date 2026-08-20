/**
 * File system utilities — 7z VSCode Extension
 *
 * Provides bidirectional copy between the local Node.js file system
 * and the Emscripten virtual file system used by the bundled 7zz WASM engine.
 *
 * IMPORTANT: All virtual FS paths must use forward slashes (/),
 * even on Windows. path.join() MUST NOT be used for FS paths —
 * use string concatenation or path.posix.join instead.
 *
 * @module utils/fs
 */

import * as fs from "fs";
import * as path from "path";
import type { JS7zInstance } from "../types";
import { safeJoinPath, checkTotalSize, isSpecialEntry, isReservedWinName } from "./security";
import { isPathExcluded, type ExclusionSet } from "./exclude";
import { getFullExt, MAX_COLLISION_RETRIES } from "../constants";
import { logger } from "./logger-core";
import { streamToVFS } from "../engines/vfs-io";
import { CancelledError } from "./cancellation";
import { checkWorkerMemory } from "../engines/worker/memory-guard";
import type { TokenLike } from "./cancellation";

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
/**
 * Create `dir` (and any missing parents) only when it does not already
 * exist. Unlike a bare `fs.mkdirSync(dir, { recursive: true })`, this never
 * mkdirs a path that already exists — on some drives (e.g. external USB
 * disks) mkdir on the drive root returns EPERM instead of EEXIST, so the
 * recursive form fails there even though the directory is present.
 */
export function ensureDirSync(dir: string): void {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
}

export function getOutputPath(inputPath: string, extension: string): string {
  const dir = path.dirname(inputPath);
  const fullExt = getFullExt(inputPath);
  const base = path.basename(inputPath, fullExt);
  const name = `${base}.${extension}`;
  let output = path.join(dir, name);
  let counter = 1;
  while (fs.existsSync(output)) {
    if (counter > MAX_COLLISION_RETRIES) {
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
  token?: TokenLike,
  onProgress?: (cumulativeBytes: number) => void,
  offsetBytes = 0,
  exclusions?: ExclusionSet,
): number {
  return copyDirToFSRec(
    js7z,
    localDir,
    fsDir,
    token,
    onProgress,
    offsetBytes,
    new Set<string>(),
    exclusions,
  );
}

/**
 * Recursive core of copyDirToFS. The realpath guard breaks circular
 * symlinks/junctions (a link pointing at an ancestor is entered once),
 * mirroring collectTarPaths so a loop cannot recurse to the OS path
 * limit; broken links are skipped like the tar backends do. Entries are
 * processed in reverse readdir order so a directory link wins over its
 * real target (matching collectTarPaths' LIFO stack: the later-seen
 * entry is visited first), keeping native and WASM archives identical.
 */
function copyDirToFSRec(
  js7z: JS7zInstance,
  localDir: string,
  fsDir: string,
  token?: TokenLike,
  onProgress?: (cumulativeBytes: number) => void,
  offsetBytes = 0,
  visitedDirs: Set<string> = new Set(),
  exclusions?: ExclusionSet,
): number {
  let real: string;
  try {
    real = fs.realpathSync(localDir);
  } catch {
    // Broken link target — not packed (mirrors the tar backends).
    logger.info({ event: "fs.copy.brokenSkip", path: localDir, fsDir });
    return 0;
  }
  if (visitedDirs.has(real)) {
    // A symlink/junction loop closes back on an already-copied real
    // directory. Warn (like fs.maxDepth.reached): the cycle is skipped so
    // the VFS copy cannot recurse until the OS path limit.
    logger.warn({ event: "fs.copy.cycleSkip", path: localDir, real, fsDir });
    return 0;
  }
  visitedDirs.add(real);

  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  let copied = 0;
  let offset = offsetBytes;
  // oxlint-disable-next-line unicorn/no-array-reverse -- ES2022 target lacks toReversed
  for (const entry of [...entries].reverse()) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const localEntry = path.join(localDir, entry.name);
    const fsEntry = `${fsDir}/${entry.name}`;
    if (exclusions && isPathExcluded(entry.name, exclusions)) continue;
    if (entry.isDirectory()) {
      js7z.FS.mkdir(fsEntry);
      const sub = copyDirToFSRec(
        js7z,
        localEntry,
        fsEntry,
        token,
        onProgress,
        offset,
        visitedDirs,
        exclusions,
      );
      copied += sub;
      offset += sub;
    } else if (entry.isSymbolicLink()) {
      // Follow symlinks (like sumTreeBytes and the rar5 engine do): a link
      // to a directory must be copied recursively, not read as a file
      // (fs.readFileSync on a symlinked directory throws EISDIR). Broken
      // links are skipped.
      let st: fs.Stats;
      try {
        st = fs.statSync(localEntry);
      } catch {
        logger.info({
          event: "fs.copy.brokenSkip",
          path: localEntry,
          fsDir: fsEntry,
        });
        continue;
      }
      if (st.isDirectory()) {
        js7z.FS.mkdir(fsEntry);
        const sub = copyDirToFSRec(
          js7z,
          localEntry,
          fsEntry,
          token,
          onProgress,
          offset,
          visitedDirs,
          exclusions,
        );
        copied += sub;
        offset += sub;
      } else {
        if (isSpecialEntry(st)) {
          // FIFO/socket/device: reading it as a file would block forever
          // (a FIFO waits for a writer). Skip like the tar backends do.
          logger.warn({
            event: "fs.copy.specialSkip",
            path: localEntry,
            fsDir: fsEntry,
          });
          continue;
        }
        streamToVFS(js7z, localEntry, fsEntry, onProgress, offset);
        copied += st.size;
        offset += st.size;
      }
    } else {
      if (isSpecialEntry(entry)) {
        logger.warn({
          event: "fs.copy.specialSkip",
          path: localEntry,
          fsDir: fsEntry,
        });
        continue;
      }
      const size = fs.statSync(localEntry).size;
      streamToVFS(js7z, localEntry, fsEntry, onProgress, offset);
      copied += size;
      offset += size;
    }
  }
  return copied;
}

/**
 * Sum the on-disk bytes of a set of local paths (files + directory trees),
 * matching the traversal of copyDirToFS/streamToVFS closely enough for
 * progress estimation. Symlinked files are counted via their target size.
 */
export function sumTreeBytes(localPaths: readonly string[], exclusions?: ExclusionSet): number {
  let total = 0;
  for (const localPath of localPaths) {
    const st = fs.statSync(localPath);
    if (!st.isDirectory()) {
      if (exclusions && isPathExcluded(path.basename(localPath), exclusions)) continue;
      total += st.size;
      continue;
    }
    const stack = [localPath];
    // Real-path guard (same as copyDirToFS): a circular junction would
    // otherwise push the same directory until the OS path limit.
    const visitedDirs = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      let real: string;
      try {
        real = fs.realpathSync(current);
      } catch {
        logger.info({ event: "fs.sumTree.brokenSkip", path: current });
        continue; // broken link target — not packed
      }
      if (visitedDirs.has(real)) {
        logger.warn({ event: "fs.sumTree.cycleSkip", path: current, real });
        continue;
      }
      visitedDirs.add(real);
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(current, e.name);
        if (exclusions && isPathExcluded(e.name, exclusions)) continue;
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isSymbolicLink()) {
          let linkStat: fs.Stats;
          try {
            linkStat = fs.statSync(full);
          } catch {
            logger.info({ event: "fs.sumTree.brokenSkip", path: full });
            continue; // broken link — not packed
          }
          if (linkStat.isDirectory()) stack.push(full);
          else if (isSpecialEntry(linkStat)) {
            logger.warn({ event: "fs.sumTree.specialSkip", path: full });
          } else total += linkStat.size;
        } else if (isSpecialEntry(e)) {
          logger.warn({ event: "fs.sumTree.specialSkip", path: full });
        } else {
          total += fs.statSync(full).size;
        }
      }
    }
  }
  return total;
}

export const MAX_DIR_DEPTH = 100;

/**
 * Recursively copy a directory from the JS7z virtual FS to the local file system.
 *
 * @param js7z - JS7z instance
 * @param fsDir - Source directory in the virtual FS (Unix-style)
 * @param localDir - Target local directory (native OS format)
 * @param enforceTotalSize - Apply the extract-total size cap per file.
 *   Host sets false after the user confirmed an oversized extraction.
 */
export function copyDirFromFS(
  js7z: JS7zInstance,
  fsDir: string,
  localDir: string,
  token?: TokenLike,
  enforceTotalSize = true,
): number {
  return _copyDirFromFS(js7z, fsDir, localDir, 0, 0, token, enforceTotalSize);
}

function _copyDirFromFS(
  js7z: JS7zInstance,
  fsDir: string,
  localDir: string,
  totalSize: number,
  depth: number,
  token?: TokenLike,
  enforceTotalSize = true,
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
    if (token?.isCancellationRequested) throw new CancelledError();
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

    // Windows cannot create DOS reserved device names (CON, NUL, COM1, …)
    // or names with trailing dots/spaces: writing them opens the device or
    // silently corrupts the name. Legal in Unix archives, so extract skips
    // them like any other unrepresentable entry.
    if (isReservedWinName(entry)) {
      logger.warn(
        { event: "fs.reservedNameSkip", entry, dir: fsDir },
        "Skipped entry with Windows-reserved name",
      );
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
        { event: "vfsio.copyDirFromFS.stat.failed" },
        "Failed to stat virtual FS entry, falling back to raw read",
      );
    }

    if (stat && js7z.FS.isDir(stat.mode)) {
      fs.mkdirSync(localEntry, { recursive: true });
      totalSize = _copyDirFromFS(
        js7z,
        fsEntry,
        localEntry,
        totalSize,
        depth + 1,
        token,
        enforceTotalSize,
      );
    } else {
      // Read the file data from VFS
      checkWorkerMemory();
      const data = js7z.FS.readFile(fsEntry, { encoding: "binary" });
      if (enforceTotalSize) totalSize = checkTotalSize(totalSize, data.byteLength);
      // Write errors propagate to caller — silent data loss is worse
      // than a reported failure
      fs.writeFileSync(localEntry, Buffer.from(data));
    }
  }
  return totalSize;
}

const SECURE_UNLINK_CHUNK = 64 * 1024;

/** O_NOFOLLOW where the platform provides it (Linux); 0 elsewhere. */
const O_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * Securely delete a file: overwrite its bytes with zeros, fsync, then
 * unlink. A plain unlink leaves the content recoverable from disk (HDDs,
 * and SSDs before TRIM), which matters when the file holds extracted
 * archive content or decrypted bytes.
 *
 * The overwrite must never follow symlinks: only regular files (verified
 * with lstat, then opened with O_NOFOLLOW where available) are rewritten;
 * a symlink or any other non-regular entry is unlinked as the directory
 * entry itself, leaving the target untouched. Missing files are a no-op.
 */
export function secureUnlink(file: string): void {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return; // missing — nothing to delete
  }
  if (st.isFile()) {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDWR | O_NOFOLLOW);
      try {
        const size = fs.fstatSync(fd).size;
        const zeros = Buffer.alloc(SECURE_UNLINK_CHUNK);
        let pos = 0;
        while (pos < size) {
          const chunk = zeros.subarray(0, Math.min(zeros.length, size - pos));
          fs.writeSync(fd, chunk, 0, chunk.length, pos);
          pos += chunk.length;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Best effort — unlink anyway.
    }
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // Best effort.
  }
}

/**
 * Securely delete a directory tree: every file inside is overwritten
 * with zeros before unlink (secureUnlink), then the directories are
 * removed. Use for temp dirs holding extracted or decrypted content —
 * a plain rmSync leaves the bytes recoverable from disk. Symlink
 * entries are unlinked as links (never followed). Missing dir is a no-op.
 */
export function secureRmDir(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing — nothing to delete
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        secureRmDir(p);
      } else {
        secureUnlink(p);
      }
    } catch {
      // Best effort — unlink is still attempted by the rmdir below.
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Best effort — the tree may be gone already.
  }
}

/**
 * Rename `src` onto `dst`, overwriting an existing `dst`. POSIX rename
 * overwrites atomically; Windows can fail with EPERM/EEXIST when the
 * destination exists, so fall back to remove-then-rename. Only use for
 * outputs that are safe to regenerate (never for the only copy of data).
 */
export function renameOverwrite(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch {
    try {
      fs.unlinkSync(dst);
    } catch {
      // destination did not exist — the original rename failed for another
      // reason (e.g. cross-device); let the retry surface the real error.
    }
    fs.renameSync(src, dst);
  }
}

export interface AtomicOutputOptions {
  /** Final output path the caller promised to the user. */
  dstPath: string;
  /** When set, the engine is expected to produce `out.001, out.002, ...`. */
  volumeSize?: string;
  /** Perform the actual write against a temp path in dstPath's directory. */
  write: (tempOutPath: string) => Promise<void>;
}

/**
 * Run a compression-style write against a temp path and only move the
 * result into place on success.
 *
 * Motivation: engines write their output in place, so a failed or
 * cancelled compression aimed at a live path (e.g. merge-over-self of a
 * split set, where dstPath === the logical source) destroys the original
 * archive. With this helper the source is untouched until the output
 * exists, and a failure/cancel cleans the temp leftovers instead.
 *
 * Temp naming: `<dir>/.sa_tmp_<pid>_<rand><ext>` — same directory (rename
 * stays on one volume), hidden-ish name, unpredictable (no symlink race
 * with attacker-writable shared tmpdirs).
 */
export async function withAtomicOutput({
  dstPath,
  volumeSize,
  write,
}: AtomicOutputOptions): Promise<void> {
  const dir = path.dirname(dstPath);
  const ext = path.extname(dstPath);
  const tmpBase = path.join(
    dir,
    `.sa_tmp_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  );
  const tmpOut = tmpBase + ext;
  const cleanup = (): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(path.basename(tmpBase))) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          // best effort
        }
      }
    }
  };
  try {
    await write(tmpOut);
    if (volumeSize) {
      // Volume set: engines produce either `tmpOut.001, .002, ...`
      // (7z/zip convention) or `tmpOut.part1.rar, .part2.rar, ...`
      // (RAR5 convention — the rar5 engine replaces the extension, so
      // tmpOut itself is never written; recovery `.rev` files may join
      // the set). Move every volume onto the final names; a single-file
      // output (engine chose not to split) is handled as a plain rename.
      let moved = 0;
      for (let i = 1; i <= 9999; i++) {
        const vol = `${tmpOut}.${String(i).padStart(3, "0")}`;
        if (!fs.existsSync(vol)) break;
        renameOverwrite(vol, `${dstPath}.${String(i).padStart(3, "0")}`);
        moved++;
      }
      const tmpBaseName = path.basename(tmpBase);
      const dstBase = dstPath.slice(0, -path.extname(dstPath).length) || dstPath;
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(tmpBaseName)) continue;
        const rest = name.slice(tmpBaseName.length);
        if (/^\.part\d+\.rar$/i.test(rest) || /^\.rev\d+\.(?:rev|rar)$/i.test(rest)) {
          renameOverwrite(path.join(dir, name), `${dstBase}${rest}`);
          moved++;
        }
      }
      if (moved === 0) renameOverwrite(tmpOut, dstPath);
    } else {
      renameOverwrite(tmpOut, dstPath);
    }
  } catch (err) {
    cleanup();
    throw err;
  }
}
