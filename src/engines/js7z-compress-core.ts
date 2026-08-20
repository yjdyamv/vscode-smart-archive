/**
 * js7z compress core — vscode-free pipeline, runs inside the
 * worker thread (engines/worker). Dispatcher: js7z-compress.
 *
 * Full compression pipeline using the bundled 7zz WASM engine: copy inputs to virtual FS,
 * build 7z arguments, run compression, read result back to local disk.
 * Handles wrapped formats (tar.gz etc.) as two-step tar + compress.
 *
 * @module engines/js7z-compress-core
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CancelledError } from "../utils/cancellation";
import type { TokenLike, ProgressLike } from "../utils/cancellation";
import type { CompressOptions, FormatInfo, JS7zInstance } from "../types";
import { JS7z } from "./js7z-factory";
import {
  createPrintBridge,
  disposeJS7z,
  INPUT_DIR,
  OUTPUT_DIR,
  copyInputsToFS,
  run7z,
} from "./js7z-helpers";
import { streamToVFS, copyToVFS } from "./vfs-io";
import { sumTreeBytes, copyDirToFS } from "../utils/fs";
import { withStage } from "../utils/progress-scale";
import { joinFSPath, getBaseName } from "../utils/path";
import { t } from "../i18n";
import { isWrappedFormat, getWrapExtension } from "../constants";
import { toBinaryVolumeSize } from "../utils/volume-sizes-core";
import { zstdCompressFile } from "./zstd-codec";
import { lz4CompressFile } from "./lz4-codec";
import { brotliCompressFile } from "./brotli-codec";
import { snappyCompressFile } from "./snappy-codec";
import { createTarFile } from "./tar-writer";
import { logger } from "../utils/logger-core";
import { validatePassword } from "../utils/security";
import { prepareExclusions, isTargetExcluded } from "../utils/exclude";
import type { SevenZipMethod } from "../types";
import {
  mapLizardLevel,
  normalizeSevenZipMethod,
  SEVEN_ZIP_METHOD_CODECS,
  xzMethodParam,
} from "../utils/sevenZipMethod";

// ── Tar backend for wrapped formats (tar.gz, tar.zst, …) ──────────────
// auto/node-tar: node-tar's Pack streams entries from disk (no VFS memory
// cost). wasm: 7zz writes the tar itself — inputs must be copied into the
// VFS first (VFS memory ≈ input size), and the archive gets standard PAX
// headers via -mm=pax (7z defaults to GNU LongLink, which the WASM 7z
// unpacker ignores). Entry names come out relative because 7zz resolves
// its inputs against the VFS cwd (FS.chdir), matching the node-tar
// backend's dirname(targets[0]) base.
let tarBackend: "auto" | "node-tar" | "wasm" = "auto";

/** Engine-config seam (worker handler / host bridge). */
export function setTarBackend(backend: "auto" | "node-tar" | "wasm"): void {
  tarBackend = backend;
}

/** mkdir every missing segment of a VFS path (FS.mkdir is single-level). */
function mkdirTree(js7z: JS7zInstance, vfsDir: string): void {
  const parts = vfsDir.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    try {
      js7z.FS.mkdir(cur);
    } catch {
      // already exists
    }
  }
}

function buildCompressArgs(
  outputFile: string,
  inputPaths: string[],
  format: FormatInfo,
  password: string,
  level: number,
  volumeSize?: string,
  sevenZipMethod?: SevenZipMethod,
  solid?: boolean,
): string[] {
  const args: string[] = ["a", outputFile];
  const method = format.label === "7z" ? normalizeSevenZipMethod(sevenZipMethod) : undefined;

  // The bundled 7zz-wasm build ships FLZMA2/ZSTD/BROTLI/LZ4/LIZARD etc.
  // Default to FLZMA2; the user picks via smart-archiver.compression.method.
  // Level 0 means store — force Copy because the fork maps -mx0 of its new
  // codecs to "fastest" (still compressing).
  if (format.label === "7z") {
    if (level === 0) {
      args.push("-m0=Copy");
    } else {
      args.push(`-m0=${SEVEN_ZIP_METHOD_CODECS[method!]}`);
    }
  } else if (format.label === "xz" && level > 0) {
    // XZ only accepts the LZMA2 filter; the flzma2 setting maps to the HC4
    // match finder (~4x faster, ~2% larger, still standard LZMA2).
    const xzParam = xzMethodParam(normalizeSevenZipMethod(sevenZipMethod));
    if (xzParam) args.push(`-m0=${xzParam}`);
  }

  // Non-solid by default (smart-archiver.compression.solid): solid archives
  // need the whole block recompressed for any delete/update. Each-file
  // blocks cost a few percent of ratio but make modification instant.
  if (format.label === "7z" && solid === false) args.push("-ms=off");

  if (password) {
    validatePassword(password);
    args.push(`-p${password}`);
    if (format.label === "7z") {
      args.push("-mhe=on");
    }
  }

  // LizardMT speaks levels 10–49; map the UI's 0–9 scale onto it.
  const mxLevel = method === "lizard" && level > 0 ? mapLizardLevel(level) : level;
  args.push(`-mx${mxLevel}`);
  args.push("-mmt=on");
  if (volumeSize) {
    args.push(`-v${toBinaryVolumeSize(volumeSize)}`);
  }
  args.push(...inputPaths);
  return args;
}

function writeVolumeFiles(js7z: JS7zInstance, vfsDir: string, outputPath: string): void {
  const outDir = path.dirname(outputPath);
  const baseName = path.basename(outputPath);
  const prefix = baseName + ".";

  const entries = js7z.FS.readdir(vfsDir).filter((e) => e !== "." && e !== "..");
  let count = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const data = js7z.FS.readFile(`${vfsDir}/${entry}`, { encoding: "binary" });
    const diskPath = path.join(outDir, entry);
    fs.writeFileSync(diskPath, Buffer.from(data));
    count++;
  }

  logger.info({ event: "compress.writeVolumes", count, outputPath });

  // If no volume files were created, fall back to a single file
  if (count === 0) {
    const mainEntry = entries.find((e) => e === baseName);
    if (mainEntry) {
      const data = js7z.FS.readFile(`${vfsDir}/${mainEntry}`, { encoding: "binary" });
      fs.writeFileSync(outputPath, Buffer.from(data));
    }
  }
}

export async function compressWith7z(
  options: CompressOptions,
  progress?: ProgressLike,
  token?: TokenLike,
  excludePatterns?: string[],
): Promise<void> {
  const prog = progress ?? { report: () => {} };

  // NOTE: the system-7z fast path is decided by the host dispatcher
  // (js7z-compress.ts) — this core always runs the WASM pipeline.

  if (options.password) {
    logger.info({ event: "compress.wasm.encrypted", format: options.format.label });
  }
  logger.info({ event: "compress.wasm.fallback", format: options.format.label });

  prog.report({ message: t("compress.initEngine") });

  const printBridge = createPrintBridge();
  const js7z = await JS7z({ print: printBridge.print, printErr: printBridge.printErr });

  // Convert gitignore patterns to 7z -xr! flags.
  // Single target: skip patterns matching the target's basename (prevents
  //   excluding the one item the user explicitly chose, e.g. a folder named "output").
  // Multiple targets: keep ALL patterns — they filter noisy targets like
  //   node_modules/.git that the user selected alongside real code.
  const singleTarget = options.targets.length === 1;
  const targetNames = new Set(options.targets.map((tg) => path.basename(tg.fsPath)));
  const excludeArgs = (excludePatterns ?? [])
    .filter((p) => {
      if (!singleTarget) return true;
      const stripped = p.replace(/^(\*\*\/)+/, "");
      return !targetNames.has(stripped);
    })
    .map((p) => "-xr!" + p.replace(/^(\*\*\/)+/, ""));

  try {
    const localPaths = options.targets.map((target) => target.fsPath);
    logger.info({
      event: "compress.start",
      format: options.format.label,
      files: localPaths.length,
      level: options.level,
    });

    const archiveName = getBaseName(options.outputPath);
    const archiveFsPath = joinFSPath(OUTPUT_DIR, archiveName);

    // Ensure the output directory exists for BOTH branches. The wrapped-format
    // path below writes options.outputPath directly, so the guard must precede
    // it — not only the non-wrapped path further down.
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

    if (isWrappedFormat("." + options.format.label)) {
      const wrapExt = getWrapExtension("." + options.format.label);
      // Derive inner tar name from output: report.tar.gz → report.tar
      let innerName = path.basename(options.outputPath, "." + options.format.label);
      if (!innerName.endsWith(".tar")) innerName += ".tar";
      const tarDiskPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sat_")), innerName);

      try {
        const packProgress = progress ? withStage(progress, "pack") : undefined;
        packProgress?.report({ message: t("compress.creatingTar") });
        // Apply single-target exclusion filter for wrapped formats (tar.gz, etc.).
        // Single target: skip patterns matching the target's basename to prevent
        // excluding the only item the user selected (e.g. a folder named "node_modules").
        // Multiple targets: keep all patterns — they filter noisy co-selected targets.
        const filteredExcludes = singleTarget
          ? (excludePatterns ?? []).filter((p) => {
              const stripped = p.replace(/^(\*\*\/)+/, "");
              return !targetNames.has(stripped);
            })
          : (excludePatterns ?? []);
        if (tarBackend === "wasm") {
          // 7zz-wasm tar backend (explicit setting): copy inputs into the
          // VFS (mirroring the non-wrapped path), then let 7zz write the
          // tar. VFS memory ≈ input size — the node-tar backend streams
          // from disk instead, which is why auto stays on node-tar.
          const copyProgress = progress ? withStage(progress, "copy") : undefined;
          copyProgress?.report({ message: t("compress.readingFiles") });
          js7z.FS.mkdir(INPUT_DIR);
          js7z.FS.mkdir(OUTPUT_DIR);
          // Multi-target exclusion filter (same as the non-wrapped path).
          let filteredPaths = localPaths;
          if (!singleTarget && excludePatterns?.length) {
            const exclusions = prepareExclusions(excludePatterns);
            filteredPaths = localPaths.filter((lp) => !isTargetExcluded(lp, exclusions));
          }
          // Place inputs under their relative paths (base = dirname of the
          // first target, mirroring collectTarPaths) so the tar entries
          // match the node-tar backend exactly.
          const rootDir = path.dirname(options.targets[0].fsPath);
          const fsInputs: string[] = [];
          const copyTotal = progress ? sumTreeBytes(filteredPaths) : 0;
          let prevCopyPct = 0;
          let offset = 0;
          const reportCopy = (cumulative: number): void => {
            if (!copyProgress || copyTotal <= 0) return;
            const pct = Math.min(99, Math.floor((cumulative / copyTotal) * 100));
            if (pct > prevCopyPct && pct > 0) {
              copyProgress.report({ message: `${pct}%`, increment: pct - prevCopyPct });
              prevCopyPct = pct;
            }
          };
          for (const lp of filteredPaths) {
            if (token?.isCancellationRequested) throw new CancelledError();
            const rel = path.relative(rootDir, lp).replace(/\\/g, "/");
            const fsTarget = joinFSPath(INPUT_DIR, rel);
            const parentDir = path.posix.dirname(fsTarget);
            if (parentDir !== INPUT_DIR) mkdirTree(js7z, parentDir);
            const stat = fs.statSync(lp);
            if (stat.isDirectory()) {
              js7z.FS.mkdir(fsTarget);
              offset += copyDirToFS(js7z, lp, fsTarget, token, reportCopy, offset);
            } else {
              offset += copyToVFS(js7z, lp, fsTarget, reportCopy, offset);
            }
            fsInputs.push(rel);
          }
          packProgress?.report({ message: t("compress.creatingTar") });
          const tarFsPath = joinFSPath(OUTPUT_DIR, innerName);
          js7z.FS.chdir(INPUT_DIR);
          await run7z(
            js7z,
            ["a", "-ttar", "-mm=pax", tarFsPath, ...fsInputs],
            packProgress,
            undefined,
            undefined,
            printBridge,
          );
          const tarBytes = js7z.FS.readFile(tarFsPath, { encoding: "binary" });
          js7z.FS.unlink(tarFsPath);
          fs.writeFileSync(tarDiskPath, Buffer.from(tarBytes));
        } else {
          await createTarFile(
            tarDiskPath,
            options.targets.map((target) => target.fsPath),
            token,
            filteredExcludes,
            packProgress,
          );
        }
        if (token?.isCancellationRequested) throw new CancelledError();

        const compressProgress = progress ? withStage(progress, "compress") : undefined;
        let compressedData: Uint8Array | undefined;
        if (wrapExt === "zst") {
          compressProgress?.report({ message: t("compress.compressingTar", wrapExt) });
          const zstOut = path.join(path.dirname(tarDiskPath), "_tmp.tar.zst");
          await zstdCompressFile(tarDiskPath, zstOut, options.level, compressProgress);
          compressedData = new Uint8Array(fs.readFileSync(zstOut));
        } else if (wrapExt === "lz4") {
          compressProgress?.report({ message: t("compress.compressingTar", wrapExt) });
          const lz4Out = path.join(path.dirname(tarDiskPath), "_tmp.tar.lz4");
          await lz4CompressFile(tarDiskPath, lz4Out, options.level, compressProgress);
          compressedData = new Uint8Array(fs.readFileSync(lz4Out));
        } else if (wrapExt === "br") {
          compressProgress?.report({ message: t("compress.compressingTar", wrapExt) });
          const brOut = path.join(path.dirname(tarDiskPath), "_tmp.tar.br");
          await brotliCompressFile(tarDiskPath, brOut, options.level, compressProgress);
          compressedData = new Uint8Array(fs.readFileSync(brOut));
        } else if (wrapExt === "sz") {
          compressProgress?.report({ message: t("compress.compressingTar", wrapExt) });
          const szOut = path.join(path.dirname(tarDiskPath), "_tmp.tar.sz");
          await snappyCompressFile(tarDiskPath, szOut, options.level, compressProgress);
          compressedData = new Uint8Array(fs.readFileSync(szOut));
        } else {
          compressProgress?.report({ message: t("compress.compressingTar", wrapExt) });
          const js7z2 = await JS7z({
            print: printBridge.print,
            printErr: printBridge.printErr,
          });
          try {
            js7z2.FS.mkdir(OUTPUT_DIR);
            streamToVFS(js7z2, tarDiskPath, `/${innerName}`);
            const wrappedArgs = ["a", archiveFsPath, `/${innerName}`, "-mmt=on"];
            // XZ wraps (tar.xz) honour the fast-LZMA2 method like plain xz.
            if (wrapExt === "xz" && options.level > 0) {
              const xzParam = xzMethodParam(normalizeSevenZipMethod(options.sevenZipMethod));
              if (xzParam) wrappedArgs.push(`-m0=${xzParam}`);
            }
            await run7z(js7z2, wrappedArgs, compressProgress, undefined, undefined, printBridge);
            compressedData = new Uint8Array(
              js7z2.FS.readFile(archiveFsPath, { encoding: "binary" }),
            );
          } finally {
            disposeJS7z(js7z2);
          }
        }

        if (token?.isCancellationRequested) throw new CancelledError();
        if (compressedData) {
          fs.writeFileSync(options.outputPath, Buffer.from(compressedData));
        } else {
          throw new Error(t("compress.failed") + path.basename(options.outputPath));
        }
      } finally {
        try {
          fs.unlinkSync(tarDiskPath);
          fs.rmSync(path.dirname(tarDiskPath), { recursive: true, force: true });
        } catch {
          logger.warn({ event: "compress.cleanup.failed" }, "Failed to clean up temporary files");
        }
      }
      return;
    }

    // Non-wrapped formats: copy inputs to VFS for 7z
    const copyProgress = progress ? withStage(progress, "copy") : undefined;
    copyProgress?.report({ message: t("compress.readingFiles") });

    // Multi-target: pre-filter targets matching exclusion patterns
    // (e.g. node_modules, .git selected alongside src at project root)
    let filteredPaths = localPaths;
    if (!singleTarget && excludePatterns?.length) {
      const exclusions = prepareExclusions(excludePatterns);
      filteredPaths = localPaths.filter((lp) => !isTargetExcluded(lp, exclusions));
    }

    js7z.FS.mkdir(INPUT_DIR);
    js7z.FS.mkdir(OUTPUT_DIR);

    const copyTotal = progress ? sumTreeBytes(filteredPaths) : 0;
    let prevCopyPct = 0;
    const allInputPaths = copyInputsToFS(js7z, filteredPaths, token, (cumulative) => {
      if (!copyProgress || copyTotal <= 0) return;
      const pct = Math.min(99, Math.floor((cumulative / copyTotal) * 100));
      if (pct > prevCopyPct && pct > 0) {
        copyProgress.report({ message: `${pct}%`, increment: pct - prevCopyPct });
        prevCopyPct = pct;
      }
    });
    // Yield briefly so queued worker messages (e.g. cancel) can run after the
    // synchronous VFS copy and before callMain blocks the event loop. The
    // window is bounded so fast operations are not delayed meaningfully.
    const cancelDeadline = Date.now() + 80;
    let cancelled = token?.isCancellationRequested ?? false;
    while (!cancelled && Date.now() < cancelDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      cancelled = token?.isCancellationRequested ?? false;
    }
    if (cancelled) throw new CancelledError();

    const args = buildCompressArgs(
      archiveFsPath,
      allInputPaths,
      options.format,
      options.password,
      options.level,
      options.volumeSize,
      options.sevenZipMethod,
      options.solid,
    );
    await run7z(
      js7z,
      [...args, ...excludeArgs],
      progress ? withStage(progress, "compress") : undefined,
      undefined,
      undefined,
      printBridge,
    );

    if (options.volumeSize) {
      writeVolumeFiles(js7z, OUTPUT_DIR, options.outputPath);
    } else {
      const data = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
      if (token?.isCancellationRequested) throw new CancelledError();
      fs.writeFileSync(options.outputPath, Buffer.from(data));
    }

    logger.info({ event: "compress.wasm.ok", outputPath: options.outputPath });
  } finally {
    disposeJS7z(js7z);
  }
}
