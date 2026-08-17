/**
 * RAR5 creation engine — Smart Archive VSCode Extension
 *
 * Native napi-rs binding (`smart-archive-rar`) wrapping the pure-Rust
 * `rar5` library (codeberg.org/yjdyamv/rar-rs fork), with a WASI
 * (wasm32-wasip1-threads) fallback when no native `.node` matches the host.
 * Creates RAR5 archives with AES-256 encryption, multi-volume output, and
 * progress reporting — no external binary required, and passwords never
 * touch the command line.
 *
 * The platform .node binary is staged under vendor/rar5-bin/<platform>/<arch>/
 * by scripts/install-rar5-platforms.js; the WASI bundle lives under
 * vendor/rar5-wasm/ (smart-archive-rar.wasi.cjs + wasm modules + worker).
 *
 * @module engines/rar5-engine
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CompressOptions } from "../types";
import { CancelledError, isCancellationError } from "../utils/cancellation";
import type { ProgressLike, TokenLike } from "../utils/cancellation";
import { withStage } from "../utils/progress-scale";
import { prepareExclusions, isPathExcluded, isTargetExcluded } from "../utils/exclude";
import { isMusl } from "../utils/platform";
import { parseSize } from "../utils/security";
import { logger } from "../utils/logger-core";

/**
 * Map the 7z-style level (0..=9, 0 = store) onto the rar5 library's range
 * (0..=5, 0 = store). Level 0 must stay 0 — the old `level || 5` fallback
 * silently turned "store only" into rar5 level 3 compression. Undefined
 * (unset) still means "default" (5).
 */
export function mapLevel(level: number | undefined): number {
  const l = level ?? 5;
  if (l <= 0) return 0;
  return Math.max(0, Math.min(5, Math.round((l * 5) / 9)));
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
      if (arch === "arm64") return "darwin-arm64";
      throw new Error(
        `unsupported darwin arch: ${arch} (native rar5 is arm64-only; WASI fallback applies)`,
      );
    case "win32":
      if (arch === "x64") return "win32-x64-msvc";
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
      dictSize?: string;
      solid?: boolean;
      quickOpen?: boolean;
      blake2?: boolean;
      threads?: number;
      saveCtime?: boolean;
      saveAtime?: boolean;
      timePrecisionSeconds?: boolean;
      saveOwner?: boolean;
      saveStreams?: boolean;
    },
    onProgress?: (err: Error | null, p: { done: number; total: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ files: string[] }>;
  appendEntries(
    opts: {
      archivePath: string;
      entries: Array<{
        kind: "file" | "dir" | "bytes";
        path?: string;
        name?: string;
        data?: Uint8Array;
      }>;
      level?: number;
      password?: string;
      dictSize?: string;
    },
    onProgress?: (err: Error | null, p: { done: number; total: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ files: string[] }>;
  deleteEntries(archivePath: string, names: string[], password?: string): number;
  listEntries(archivePath: string, password?: string): string[];
  listEntriesDetailed(
    archivePath: string,
    password?: string,
  ): Array<{
    name: string;
    size: number;
    packedSize: number;
    method: number;
    isDir: boolean;
    mtime: number;
  }>;
  extractArchive(
    archivePath: string,
    opts: {
      destPath: string;
      password?: string;
      flat?: boolean;
      maxDictSize?: number;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  repairArchive(inputPath: string, outputPath: string): void;
  rebuildMissingVolumes(firstVolume: string): string[];
}

/** One member's details from [`listRar5EntriesDetailed`]. */
export interface Rar5EntryInfo {
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** On-disk (packed) size in bytes. */
  packedSize: number;
  /** Compression method: 0 = store, 1..=5. */
  method: number;
  isDir: boolean;
  /** Modification time as Unix seconds (0 when unknown). */
  mtime: number;
}

/** Options for [`extractWithRar5`]. */
export interface ExtractRar5Options {
  /** Extract members flat (basename only, no directory tree). */
  flat?: boolean;
  /**
   * Maximum dictionary size in bytes accepted when decoding a member
   * (WinRAR-compatible default: 4 GiB; RAR7 v70 members with larger
   * dictionaries are refused). Pass 0 for no limit.
   */
  maxDictSize?: number;
}

export type Rar5Backend = "auto" | "native" | "wasm";

/** Injected config: rar5Backend setting (wired by utils/config.ts). */
let rar5Config: { backend?: Rar5Backend } = {};

/**
 * Inject the rar5Backend setting. The host wires it from
 * `smart-archive.rar5Backend`; tests inject it directly. `auto` keeps the
 * native-first / WASI-fallback behaviour.
 */
export function setRar5Config(config: { backend?: Rar5Backend }): void {
  rar5Config = config;
}

/**
 * Resolve the active backend. SA_RAR5_FORCE_WASM=1 (used by CI/tests) takes
 * precedence over the setting so forced-WASM runs stay reproducible.
 */
export function resolveRar5Backend(): Rar5Backend {
  if (process.env.SA_RAR5_FORCE_WASM === "1") return "wasm";
  const backend = rar5Config.backend ?? "auto";
  return backend === "native" || backend === "wasm" ? backend : "auto";
}

let nativeBinding: Rar5Binding | undefined;
let wasmBinding: Rar5Binding | undefined;
let nativeBindingError: Error | undefined;
let wasmBindingError: Error | undefined;

/** Drop cached bindings/errors (e.g. after a setting change or re-stage). */
export function resetRar5BindingCache(): void {
  nativeBinding = undefined;
  wasmBinding = undefined;
  nativeBindingError = undefined;
  wasmBindingError = undefined;
}

function loadNativeBinding(): Rar5Binding {
  if (nativeBinding) return nativeBinding;
  if (nativeBindingError) throw nativeBindingError;
  const triple = resolveRarTriple();
  const rel = path.join(
    "vendor",
    "rar5-bin",
    process.platform,
    process.arch,
    `smart-archive-rar.${triple}.node`,
  );
  // Compiled bundle: out/extension.js → <root>/vendor/rar5-bin. Vitest/dev
  // (source modules): src/engines/... → <root>/vendor/rar5-bin. Try both.
  const candidates = [path.join(__dirname, "..", rel), path.join(__dirname, "..", "..", rel)];
  const nodePath = candidates.find((c) => fs.existsSync(c));
  if (!nodePath) {
    throw new Error(
      `rar5 native module not found (tried: ${candidates.join(", ")}) — run ` +
        "`SA_RAR5_DEV=1 node scripts/install-rar5-platforms.js` or publish prebuilds",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    nativeBinding = require(nodePath) as Rar5Binding;
    logger.info({ event: "rar5.bindingLoaded", triple, path: nodePath });
    return nativeBinding;
  } catch (err) {
    nativeBindingError = err instanceof Error ? err : new Error(String(err));
    throw nativeBindingError;
  }
}

function loadWasmBinding(): Rar5Binding {
  if (wasmBinding) return wasmBinding;
  if (wasmBindingError) throw wasmBindingError;
  const rel = path.join("vendor", "rar5-wasm", "smart-archive-rar.wasi.cjs");
  const candidates = [path.join(__dirname, "..", rel), path.join(__dirname, "..", "..", rel)];
  const loaderPath = candidates.find((c) => fs.existsSync(c));
  if (!loaderPath) {
    throw new Error(
      `rar5 wasm loader not found (tried: ${candidates.join(", ")}) — run ` +
        "`SA_RAR5_DEV=1 node scripts/install-rar5-platforms.js` after building the WASI target",
    );
  }
  // WASI cannot see the host CPU count; the generated loader forwards
  // process.env to its worker threads, so size the guest Rayon pools from
  // the real host. SA_RAR5_WASM_WORKERS stays user-overridable.
  if (!process.env.SA_RAR5_WASM_WORKERS) {
    const cores =
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    process.env.SA_RAR5_WASM_WORKERS = String(Math.max(1, cores));
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    wasmBinding = require(loaderPath) as Rar5Binding;
    logger.info({
      event: "rar5.wasmLoaded",
      path: loaderPath,
      workers: process.env.SA_RAR5_WASM_WORKERS,
    });
    return wasmBinding;
  } catch (err) {
    wasmBindingError = err instanceof Error ? err : new Error(String(err));
    throw wasmBindingError;
  }
}

function loadBinding(): Rar5Binding {
  const backend = resolveRar5Backend();
  const errors: Error[] = [];
  if (backend === "wasm") {
    try {
      return loadWasmBinding();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  } else if (backend === "native") {
    try {
      return loadNativeBinding();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  } else {
    try {
      return loadNativeBinding();
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      errors.push(wrapped);
      logger.warn({ event: "rar5.nativeUnavailable", error: wrapped.message });
    }
    try {
      return loadWasmBinding();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  throw new Error(
    `rar5 engine unavailable (backend "${backend}"): ` + errors.map((e) => e.message).join(" | "),
  );
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
    total += fs.statSync(e.path).size;
  }
  return total;
}

/** Repair a damaged RAR5 archive using its inline recovery record. */
export function repairWithRar5(inputPath: string, outputPath: string): void {
  const mod = loadBinding();
  mod.repairArchive(inputPath, outputPath);
}

/**
 * Rebuild missing volumes of a multi-volume RAR5 set from its `.rev`
 * recovery volumes (WinRAR `rc` equivalent). `firstVolume` is the path
 * of `name.part1.rar`; returns the paths of all volumes produced.
 */
export function rebuildMissingVolumesWithRar5(firstVolume: string): string[] {
  const mod = loadBinding();
  return mod.rebuildMissingVolumes(firstVolume);
}

export async function compressWithRar5(
  options: CompressOptions,
  progress?: ProgressLike,
  token?: TokenLike,
  excludePatterns?: string[],
): Promise<void> {
  const prog: ProgressLike = withStage(progress ?? { report: () => {} }, "compress");
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
    // Ignore zero, repeats and any out-of-order report so the VS Code bar
    // never stalls on 0 or moves backwards.
    if (pct <= 0 || pct <= lastPct) return;
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
        dictSize: options.dictSize || undefined,
        solid: options.solid ?? undefined,
        quickOpen: options.quickOpen ?? undefined,
        blake2: options.blake2 ?? undefined,
        threads: options.threads ?? undefined,
        saveCtime: options.saveCtime ?? undefined,
        saveAtime: options.saveAtime ?? undefined,
        timePrecisionSeconds: options.timePrecisionSeconds ?? undefined,
        saveOwner: options.saveOwner ?? undefined,
        saveStreams: options.saveStreams ?? undefined,
      },
      (err, p) => {
        if (err) return;
        const pct = Math.min(100, Math.floor((p.done / Math.max(p.total, 1)) * 100));
        reportPct(pct);
      },
      controller.signal,
    );
  } catch (err) {
    if (isCancellationError(err)) {
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

/** List the member names of a RAR5 archive (for directory expansion). */
export function listRar5Entries(archivePath: string, password?: string): string[] {
  const mod = loadBinding();
  return mod.listEntries(archivePath, password || undefined);
}

/** List the members of a RAR5 archive with sizes and methods. */
export function listRar5EntriesDetailed(archivePath: string, password?: string): Rar5EntryInfo[] {
  const mod = loadBinding();
  return mod.listEntriesDetailed(archivePath, password || undefined);
}

/**
 * Extract a RAR5 archive into a directory using the rar5 binding (fully
 * streaming, so arbitrarily large members work; RAR7 v70 members are
 * accepted with `maxDictSize: 0`).
 */
export async function extractWithRar5(
  archivePath: string,
  destPath: string,
  password: string,
  opts: ExtractRar5Options = {},
  token?: TokenLike,
): Promise<void> {
  const mod = loadBinding();
  const controller = new AbortController();
  let disposable: { dispose(): void } | undefined;
  if (token) {
    disposable = token.onCancellationRequested?.(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
  }
  try {
    await mod.extractArchive(
      archivePath,
      {
        destPath,
        password: password || undefined,
        flat: opts.flat ?? undefined,
        maxDictSize: opts.maxDictSize ?? undefined,
      },
      controller.signal,
    );
  } finally {
    disposable?.dispose();
  }
}

/**
 * Expand an archive-view selection into exact member names: a selected
 * directory matches itself and every member under its `dir/` prefix; a
 * selected file matches its exact member name.
 */
export function expandRarSelection(allNames: string[], selected: string[]): string[] {
  const names = new Set<string>();
  for (const sel of selected) {
    const norm = sel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (norm === "") continue;
    if (names.has(norm)) continue;
    if (allNames.includes(norm)) {
      names.add(norm);
      continue;
    }
    const prefix = norm.endsWith("/") ? norm : `${norm}/`;
    let matched = 0;
    for (const n of allNames) {
      if (n.startsWith(prefix)) {
        names.add(n);
        matched++;
      }
    }
    if (matched === 0) {
      // A directory entry that carries no children is itself a member.
      names.add(norm);
    }
  }
  return [...names];
}

/**
 * Append local files/folders to an existing single-volume RAR5 archive
 * without rebuilding it: existing members are preserved verbatim, only the
 * trailing quick-open/recovery/end blocks are truncated and rewritten.
 * Throws when the archive is multi-volume, locked, or not RAR5.
 */
export async function appendWithRar5(
  archivePath: string,
  localPaths: string[],
  targetDir: string,
  password: string,
  excludePatterns: string[],
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<void> {
  const prog: ProgressLike = withStage(progress ?? { report: () => {} }, "append");
  const mod = loadBinding();
  const entries = collectEntries(
    localPaths.map((p) => ({ fsPath: p })),
    excludePatterns,
  );
  if (entries.length === 0) {
    throw new Error("No files to add (all targets excluded)");
  }
  const bindingEntries = entries.map((e) => ({
    kind: e.kind,
    path: e.path,
    name: targetDir ? `${targetDir.replace(/\\/g, "/")}/${e.name}` : e.name,
  }));

  const controller = new AbortController();
  let disposable: { dispose(): void } | undefined;
  if (token) {
    disposable = token.onCancellationRequested?.(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
  }

  let lastPct = -1;
  const reportPct = (pct: number) => {
    if (pct <= 0 || pct <= lastPct) return;
    const delta = pct - (lastPct < 0 ? 0 : lastPct);
    lastPct = pct;
    prog.report({ message: `${pct}%`, increment: delta });
  };

  try {
    await mod.appendEntries(
      {
        archivePath,
        entries: bindingEntries,
        level: 3,
        password: password || undefined,
        dictSize: undefined,
      },
      (err, p) => {
        if (err) return;
        const pct = Math.min(100, Math.floor((p.done / Math.max(p.total, 1)) * 100));
        reportPct(pct);
      },
      controller.signal,
    );
  } catch (err) {
    if (isCancellationError(err)) {
      throw new CancelledError();
    }
    throw err;
  } finally {
    disposable?.dispose();
  }
  reportPct(100);
}

/**
 * Delete members from a RAR5 archive without rebuilding it. Directories in
 * the selection are expanded to all members below them via
 * {@link expandRarSelection}. Returns the number of deleted members.
 */
export function deleteWithRar5(
  archivePath: string,
  selectedPaths: string[],
  password: string,
): number {
  const mod = loadBinding();
  const allNames = mod.listEntries(archivePath, password || undefined);
  const names = expandRarSelection(allNames, selectedPaths);
  if (names.length === 0) {
    throw new Error("No members match the selection");
  }
  return mod.deleteEntries(archivePath, names, password || undefined);
}
