/**
 * RAR5 creation engine — Smart Archive VSCode Extension
 *
 * Native napi-rs binding (`smart-archive-rar`) wrapping the pure-Rust
 * `rar5` library (codeberg.org/yjdyamv/rar-rs fork). Creates RAR5
 * archives with AES-256 encryption, multi-volume output, and progress
 * reporting — no external binary required, and passwords never touch
 * the command line.
 *
 * The platform .node binary is staged under rar5-bin/<platform>/<arch>/
 * by scripts/install-rar5-platforms.js.
 *
 * @module engines/rar5-engine
 */

import * as fs from "fs";
import * as path from "path";
import type { CompressOptions } from "../types";
import { CancelledError, isCancellationError } from "../utils/cancellation";
import type { ProgressLike, TokenLike } from "../utils/cancellation";
import { prepareExclusions, isPathExcluded, isTargetExcluded } from "../utils/exclude";
import { isMusl } from "../utils/platform";
import { checkFileSize, checkTotalSize, parseSize } from "../utils/security";
import { logger } from "../utils/logger";

/** The rar5 library supports compression levels 0..=5; 7z uses 0..=9. */
function mapLevel(level: number): number {
  return Math.max(0, Math.min(5, Math.round(((level || 5) * 5) / 9)));
}

/** napi-rs triple naming, e.g. linux-x64-gnu / win32-arm64-msvc. */
export function resolveRarTriple(): string {
  const arch = process.arch;
  switch (process.platform) {
    case "linux":
      if (arch === "x64") return isMusl() ? "linux-x64-musl" : "linux-x64-gnu";
      if (arch === "arm64") return isMusl() ? "linux-arm64-musl" : "linux-arm64-gnu";
      if (arch === "arm") return "linux-arm-gnueabihf";
      throw new Error(`unsupported linux arch: ${arch}`);
    case "darwin":
      if (arch === "x64") return "darwin-x64";
      if (arch === "arm64") return "darwin-arm64";
      throw new Error(`unsupported darwin arch: ${arch}`);
    case "win32":
      if (arch === "x64") return "win32-x64-msvc";
      if (arch === "ia32") return "win32-ia32-msvc";
      if (arch === "arm64") return "win32-arm64-msvc";
      throw new Error(`unsupported win32 arch: ${arch}`);
    default:
      throw new Error(`rar5 engine unsupported platform: ${process.platform}`);
  }
}

interface Rar5Binding {
  createArchive(
    opts: {
      outPath: string;
      entries: Array<{
        kind: "file" | "dir" | "bytes";
        path?: string;
        name?: string;
        data?: Uint8Array;
      }>;
      level?: number;
      password?: string;
      encryptHeaders?: boolean;
      recoveryPercent?: number;
      recoveryVolumeCount?: number;
      volumeSize?: number;
      maxTotalBytes?: number;
    },
    onProgress?: (err: Error | null, p: { done: number; total: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ files: string[] }>;
  repairArchive(inputPath: string, outputPath: string): void;
}

let binding: Rar5Binding | undefined;
let bindingError: Error | undefined;

function loadBinding(): Rar5Binding {
  if (binding) return binding;
  if (bindingError) throw bindingError;
  try {
    const triple = resolveRarTriple();
    const rel = path.join(
      "rar5-bin",
      process.platform,
      process.arch,
      `smart-archive-rar.${triple}.node`,
    );
    // Compiled bundle: out/extension.js → <root>/rar5-bin. Vitest/dev (source
    // modules): src/engines/... → <root>/rar5-bin. Try both layouts.
    const candidates = [path.join(__dirname, "..", rel), path.join(__dirname, "..", "..", rel)];
    const nodePath = candidates.find((c) => fs.existsSync(c));
    if (!nodePath) {
      throw new Error(
        `rar5 native module not found (tried: ${candidates.join(", ")}) — run ` +
          "`SA_RAR5_DEV=1 node scripts/install-rar5-platforms.js` or publish prebuilds",
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    binding = require(nodePath) as Rar5Binding;
    logger.info({ event: "rar5.bindingLoaded", triple, path: nodePath });
  } catch (err) {
    bindingError = err instanceof Error ? err : new Error(String(err));
    throw bindingError;
  }
  return binding;
}

/** Collect disk entries with exclusion filtering applied at every level. */
interface CollectedEntry {
  kind: "file" | "dir";
  path: string;
  name: string;
}

function collectEntries(
  targets: readonly { fsPath: string }[],
  excludePatterns: string[],
): CollectedEntry[] {
  const entries: CollectedEntry[] = [];
  const exclusions = prepareExclusions(excludePatterns);

  for (const target of targets) {
    if (excludePatterns.length > 0 && isTargetExcluded(target.fsPath, exclusions)) {
      logger.info({ event: "rar5.excludedTarget", path: target.fsPath });
      continue;
    }
    const name = path.basename(target.fsPath);
    if (!fs.existsSync(target.fsPath)) {
      throw new Error(`Target does not exist: ${target.fsPath}`);
    }
    const stat = fs.statSync(target.fsPath); // follows symlinks
    if (stat.isFile()) {
      entries.push({ kind: "file", path: target.fsPath, name });
    } else if (stat.isDirectory()) {
      entries.push({ kind: "dir", path: target.fsPath, name });
      const stack: Array<{ dir: string; rel: string }> = [{ dir: target.fsPath, rel: name }];
      // Real-path guard: symlinked directories (followed via realpath) must
      // not loop back into an ancestor.
      const visited = new Set<string>();
      while (stack.length > 0) {
        const { dir, rel } = stack.pop()!;
        let children: fs.Dirent[];
        try {
          children = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          const childRel = `${rel}/${child.name}`;
          if (isPathExcluded(childRel, exclusions)) continue;
          const childFull = path.join(dir, child.name);
          if (child.isDirectory()) {
            entries.push({ kind: "dir", path: childFull, name: childRel });
            stack.push({ dir: childFull, rel: childRel });
          } else if (child.isFile()) {
            entries.push({ kind: "file", path: childFull, name: childRel });
          } else if (child.isSymbolicLink()) {
            // rar-rs cannot store symlink entries yet; follow the link and
            // add the target as a regular entry (7-Zip stores links, so this
            // is the closest equivalent until the fork gains symlink support).
            try {
              const real = fs.realpathSync(childFull);
              if (visited.has(real)) continue;
              const rstat = fs.statSync(real);
              if (rstat.isDirectory()) {
                visited.add(real);
                entries.push({ kind: "dir", path: real, name: childRel });
                stack.push({ dir: real, rel: childRel });
              } else if (rstat.isFile()) {
                entries.push({ kind: "file", path: real, name: childRel });
              }
            } catch {
              // dangling or looping symlink — skip
            }
          }
        }
      }
    }
  }
  return entries;
}

function totalBytes(entries: CollectedEntry[]): number {
  let total = 0;
  for (const e of entries) {
    const size = fs.statSync(e.path).size;
    checkFileSize(size);
    total = checkTotalSize(total, size);
  }
  return total;
}

/** Repair a damaged RAR5 archive using its inline recovery record. */
export function repairWithRar5(inputPath: string, outputPath: string): void {
  const mod = loadBinding();
  mod.repairArchive(inputPath, outputPath);
}

export async function compressWithRar5(
  options: CompressOptions,
  progress?: ProgressLike,
  token?: TokenLike,
  excludePatterns?: string[],
): Promise<void> {
  const prog: ProgressLike = progress ?? { report: () => {} };
  const mod = loadBinding();

  const singleTarget = options.targets.length === 1;
  const targetNames = new Set(options.targets.map((tg) => path.basename(tg.fsPath)));
  const filteredExcludes = (excludePatterns ?? []).filter((p) => {
    if (!singleTarget) return true;
    const stripped = p.replace(/^(\*\*\/)+/, "");
    return !targetNames.has(stripped);
  });

  const entries = collectEntries(options.targets, filteredExcludes);
  if (entries.length === 0) {
    throw new Error("No files to archive (all targets excluded)");
  }

  const total = totalBytes(entries);
  logger.info({
    event: "rar5.compress.start",
    format: options.format.label,
    files: entries.length,
    level: mapLevel(options.level),
    totalBytes: total,
    encrypted: Boolean(options.password),
    volumes: Boolean(options.volumeSize),
  });

  const volumeSize = options.volumeSize ? parseSize(options.volumeSize, 0) : undefined;

  const controller = new AbortController();
  let disposable: { dispose(): void } | undefined;
  if (token) {
    disposable = token.onCancellationRequested?.(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
  }

  const bindingEntries = entries.map((e) => ({
    kind: e.kind,
    path: e.path,
    name: e.name,
  }));

  // Deterministic progress: report cumulative increment so the VS Code
  // notification shows a real percentage bar (message-only reports render
  // as an indeterminate spinner that can lag/stall on fast compressions).
  let lastPct = -1;
  const reportPct = (pct: number) => {
    if (pct <= 0 || pct === lastPct) return;
    const delta = pct - (lastPct < 0 ? 0 : lastPct);
    lastPct = pct;
    prog.report({ message: `${pct}%`, increment: delta });
  };

  try {
    await mod.createArchive(
      {
        outPath: options.outputPath,
        entries: bindingEntries,
        level: mapLevel(options.level),
        password: options.password || undefined,
        encryptHeaders: options.encryptHeaders ?? false,
        recoveryPercent: options.recoveryPercent ?? 0,
        recoveryVolumeCount: options.recoveryVolumeCount ?? 0,
        volumeSize: volumeSize && volumeSize > 0 ? volumeSize : undefined,
      },
      (err, p) => {
        if (err) return;
        const pct = Math.min(100, Math.floor((p.done / Math.max(p.total, 1)) * 100));
        reportPct(pct);
      },
      controller.signal,
    );
  } catch (err) {
    if (isCancellationError(err) || (err instanceof Error && err.name === "AbortError")) {
      cleanupPartialOutput(options.outputPath);
      throw new CancelledError();
    }
    throw err;
  } finally {
    disposable?.dispose();
  }

  // The libuv task cannot be interrupted mid-compute; if the user cancelled
  // while it was running, remove the finished archive and report cancellation.
  if (token?.isCancellationRequested) {
    cleanupPartialOutput(options.outputPath);
    throw new CancelledError();
  }

  // Force the bar to 100% — progress events are delivered asynchronously and
  // may otherwise leave the notification stuck on a stale low percentage.
  reportPct(100);
}

function cleanupPartialOutput(outputPath: string): void {
  try {
    const dir = path.dirname(outputPath);
    const base = path.basename(outputPath);
    for (const f of fs.readdirSync(dir)) {
      if (f === base || (f.startsWith(base) && f.endsWith(".rar"))) {
        const full = path.join(dir, f);
        logger.info({ event: "rar5.cleanupPartial", path: full });
        fs.rmSync(full, { force: true });
      }
    }
  } catch {
    // best-effort cleanup
  }
}
