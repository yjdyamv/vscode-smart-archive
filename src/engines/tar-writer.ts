/**
 * TAR writer — Smart Archiver VSCode Extension
 *
 * JS tar backend: streams a TAR archive to disk with node-tar's Pack,
 * never loading files into memory (bypasses WASM limits). Used by the
 * worker/WASM engine for wrapped formats (tar.gz / tar.zst / ...). The
 * system7z engine runs its own native backend (`7z a -ttar` with a
 * pre-walked @listfile); this module owns the shared pre-walk both
 * backends use.
 *
 * @module engines/tar-writer
 */

import * as fs from "fs";
import * as path from "path";
import { Pack } from "tar";
import { prepareExclusions, isPathExcluded } from "../utils/exclude";
import { CancelledError } from "../utils/cancellation";
import type { TokenLike, ProgressLike } from "../utils/cancellation";

/**
 * Result of the cycle-safe, exclusion-aware pre-walk of one directory.
 */
export interface TarWalk {
  /** Absolute file paths (incl. symlinks-to-files), walk order. */
  files: string[];
  /** Absolute directory paths that were entered, walk order. */
  dirs: string[];
  /** Subset of dirs whose post-exclusion entries are empty. */
  emptyDirs: string[];
}

export function collectTarPaths(
  basePath: string,
  exclusions: ReturnType<typeof prepareExclusions>,
  token?: TokenLike,
): TarWalk {
  const files: string[] = [];
  const dirs: string[] = [];
  const emptyDirs: string[] = [];
  const stack = [basePath];
  // Real path of every directory we have entered, to break circular
  // symlinks (a link pointing at an ancestor) without dropping files.
  const visitedDirs = new Set<string>();
  while (stack.length > 0) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const current = stack.pop()!;
    const real = fs.realpathSync(current);
    if (visitedDirs.has(real)) continue;
    visitedDirs.add(real);
    const entries = fs.readdirSync(current, { withFileTypes: true });
    let sawEntry = false;
    for (const e of entries) {
      const full = path.join(current, e.name);
      const rel = path.relative(basePath, full).replace(/\\/g, "/");
      if (isPathExcluded(rel, exclusions)) continue;
      sawEntry = true;
      if (e.isDirectory()) {
        dirs.push(full);
        stack.push(full);
      } else if (e.isFile()) {
        files.push(full);
      } else if (e.isSymbolicLink()) {
        // Follow the link: a link to a directory is walked like a
        // directory, a link to a file is stored as its content. The packer
        // reads through the link, so the target's bytes land in the tar
        // while the archive stays WASM-7z compatible (no GNU type '2'
        // symlink entries). Broken links are skipped.
        let target: fs.Stats;
        try {
          target = fs.statSync(full);
        } catch {
          continue;
        }
        if (target.isDirectory()) {
          dirs.push(full);
          stack.push(full);
        } else {
          files.push(full);
        }
      }
    }
    if (!sawEntry) emptyDirs.push(current);
  }
  return { files, dirs, emptyDirs };
}

/**
 * Pre-walk the inputs to estimate the tar's total on-disk byte size.
 * Mirrors the writer's semantics closely enough for progress estimation:
 * top-level entries are stat'd with symlink following (like the writer),
 * inner entries follow symlinks too (the writer dereferences them) and
 * honour the exclusion patterns.
 */
function computeTotalBytes(
  localPaths: readonly string[],
  exclusions: ReturnType<typeof prepareExclusions>,
  token?: TokenLike,
): number {
  const rootDir = path.dirname(localPaths[0]);
  let total = 0;
  for (const loc of localPaths) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const st = fs.statSync(loc);
    if (!st.isDirectory()) {
      total += st.size;
      continue;
    }
    const stack = [loc];
    const visitedDirs = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      const real = fs.realpathSync(current);
      if (visitedDirs.has(real)) continue;
      visitedDirs.add(real);
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(current, e.name);
        const rel = path.relative(rootDir, full).replace(/\\/g, "/");
        if (isPathExcluded(rel, exclusions)) continue;
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          total += fs.statSync(full).size;
        } else if (e.isSymbolicLink()) {
          let target: fs.Stats;
          try {
            target = fs.statSync(full);
          } catch {
            continue; // broken link — not packed
          }
          if (target.isDirectory()) {
            stack.push(full);
          } else {
            total += target.size;
          }
        }
      }
    }
  }
  return total;
}

export async function createTarFile(
  outputPath: string,
  localPaths: readonly string[],
  token?: TokenLike,
  excludePatterns: string[] = [],
  progress?: ProgressLike,
): Promise<void> {
  if (localPaths.length === 0) {
    throw new Error("No files to add to TAR archive");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const exclusions = prepareExclusions(excludePatterns);
  const totalBytes = progress ? computeTotalBytes(localPaths, exclusions, token) : 0;
  const rootDir = path.dirname(localPaths[0]);
  const toRel = (full: string) => path.relative(rootDir, full).replace(/\\/g, "/");

  // Pre-walk every target into an explicit relative entry list. Pack would
  // recurse any directory it receives itself; the explicit list keeps the
  // walk's cycle guard, exclusions and symlink handling authoritative
  // (noDirRecurse writes exactly the listed entries).
  const entries: string[] = [];
  for (const loc of localPaths) {
    if (token?.isCancellationRequested) throw new CancelledError();
    // statSync follows top-level symlinks: a link to a file is stored as
    // its content, a link to a directory is walked like a directory.
    const st = fs.statSync(loc);
    entries.push(toRel(loc));
    if (st.isDirectory()) {
      const walk = collectTarPaths(loc, exclusions, token);
      for (const d of walk.dirs) entries.push(toRel(d));
      for (const f of walk.files) entries.push(toRel(f));
    }
  }

  let written = 0;
  let lastPct = 0;
  const reportProgress = () => {
    if (!progress || totalBytes <= 0) return;
    const pct = Math.min(99, Math.floor((written / totalBytes) * 100));
    if (pct > lastPct && pct > 0) {
      progress.report({ message: `${pct}%`, increment: pct - lastPct });
      lastPct = pct;
    }
  };

  const pack = new Pack({
    cwd: rootDir,
    follow: true, // dereference symlinks → store the target's content
    portable: true, // omit uid/gid/uname — WASM-7z-clean headers
    noDirRecurse: true, // pack exactly the pre-walked entries
  });
  // Byte-accurate progress: every streamed tar byte (headers + content).
  pack.on("data", (chunk: Buffer) => {
    written += chunk.length;
    reportProgress();
  });
  const stream = fs.createWriteStream(outputPath);
  pack.pipe(stream);
  const done = new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("close", resolve);
    pack.on("error", reject);
  });
  const cancelSub = token?.onCancellationRequested?.(() => {
    if (!pack.destroyed) pack.destroy(new CancelledError());
  });
  try {
    for (const rel of entries) {
      if (token?.isCancellationRequested && !pack.destroyed) {
        pack.destroy(new CancelledError());
      }
      if (pack.destroyed) break;
      pack.add(rel);
    }
    if (!pack.destroyed) pack.end();
    await done;
  } finally {
    cancelSub?.dispose?.();
  }
}
