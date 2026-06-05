/**
 * js7z compress — Smart Archive VSCode Extension
 *
 * Full compression pipeline using js7z-tools: copy inputs to virtual FS,
 * build 7z arguments, run compression, read result back to local disk.
 * Handles wrapped formats (tar.gz etc.) as two-step tar + compress.
 *
 * @module engines/js7z-compress
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { CompressOptions, FormatInfo, JS7zInstance } from "../types";
import { JS7z } from "./js7z-factory";
import { disposeJS7z, INPUT_DIR, OUTPUT_DIR, copyInputsToFS, run7z } from "./js7z-helpers";
import { streamToVFS } from "./vfs-io";
import { joinFSPath, getBaseName } from "../utils/path";
import { t } from "../i18n";
import { isWrappedFormat, getWrapExtension } from "../constants";
import { toBinaryVolumeSize } from "../utils/volume-sizes";
import { zstdCompressFile } from "./zstd-codec";
import { lz4CompressFile } from "./lz4-codec";
import { brotliCompressFile } from "./brotli-codec";
import { createTarFile } from "./tar-writer";
import { logger } from "../utils/logger";
import { validatePassword } from "../utils/security";
import { prepareExclusions, isTargetExcluded } from "../utils/exclude";
import { hasSystem7zForFormat, compressWithSystem7z } from "./system7z";

function buildCompressArgs(
  outputFile: string,
  inputPaths: string[],
  format: FormatInfo,
  password: string,
  level: number,
  volumeSize?: string,
): string[] {
  const args: string[] = ["a", outputFile];

  if (password) {
    validatePassword(password);
    args.push(`-p${password}`);
    if (format.label === "7z") {
      args.push("-mhe=on");
    }
  }

  args.push(`-mx${level}`);
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
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
  excludePatterns?: string[],
): Promise<void> {
  const prog = progress ?? { report: () => {} };

  if (hasSystem7zForFormat(options.format.label)) {
    logger.info({ event: "compress.usingSystem7z", format: options.format.label });
    await compressWithSystem7z(options, progress, token, excludePatterns);
    return;
  }

  logger.info({ event: "compress.wasm.fallback", format: options.format.label });

  prog.report({ message: t("compress.initEngine") });

  const js7z = await JS7z();

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

    if (isWrappedFormat("." + options.format.label)) {
      const wrapExt = getWrapExtension("." + options.format.label);
      // Derive inner tar name from output: report.tar.gz → report.tar
      let innerName = path.basename(options.outputPath, "." + options.format.label);
      if (!innerName.endsWith(".tar")) innerName += ".tar";
      const tarDiskPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sat_")), innerName);

      try {
        prog.report({ message: t("compress.creatingTar") });
        await createTarFile(
          tarDiskPath,
          options.targets.map((target) => target.fsPath),
          token,
          excludePatterns,
        );
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        let compressedData: Uint8Array | undefined;
        if (wrapExt === "zst") {
          prog.report({ message: t("compress.compressingTar", wrapExt) });
          const zstOut = path.join(path.dirname(tarDiskPath), "_tmp.tar.zst");
          await zstdCompressFile(tarDiskPath, zstOut, options.level);
          compressedData = new Uint8Array(fs.readFileSync(zstOut));
        } else if (wrapExt === "lz4") {
          prog.report({ message: t("compress.compressingTar", wrapExt) });
          const lz4Out = path.join(path.dirname(tarDiskPath), "_tmp.tar.lz4");
          await lz4CompressFile(tarDiskPath, lz4Out, options.level);
          compressedData = new Uint8Array(fs.readFileSync(lz4Out));
        } else if (wrapExt === "br") {
          prog.report({ message: t("compress.compressingTar", wrapExt) });
          const brOut = path.join(path.dirname(tarDiskPath), "_tmp.tar.br");
          await brotliCompressFile(tarDiskPath, brOut, options.level);
          compressedData = new Uint8Array(fs.readFileSync(brOut));
        } else {
          prog.report({ message: t("compress.compressingTar", wrapExt) });
          const js7z2 = await JS7z();
          try {
            js7z2.FS.mkdir(OUTPUT_DIR);
            streamToVFS(js7z2, tarDiskPath, `/${innerName}`);
            await run7z(js7z2, ["a", archiveFsPath, `/${innerName}`, "-mmt=on"], progress);
            compressedData = new Uint8Array(
              js7z2.FS.readFile(archiveFsPath, { encoding: "binary" }),
            );
          } finally {
            disposeJS7z(js7z2);
          }
        }

        if (token?.isCancellationRequested) throw new vscode.CancellationError();
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
    prog.report({ message: t("compress.readingFiles") });

    // Multi-target: pre-filter targets matching exclusion patterns
    // (e.g. node_modules, .git selected alongside src at project root)
    let filteredPaths = localPaths;
    if (!singleTarget && excludePatterns?.length) {
      const exclusions = prepareExclusions(excludePatterns);
      filteredPaths = localPaths.filter((lp) => !isTargetExcluded(lp, exclusions));
    }

    js7z.FS.mkdir(INPUT_DIR);
    js7z.FS.mkdir(OUTPUT_DIR);

    const allInputPaths = copyInputsToFS(js7z, filteredPaths, token);
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    prog.report({ message: t("compress.addedItems", String(localPaths.length)) });

    const args = buildCompressArgs(
      archiveFsPath,
      allInputPaths,
      options.format,
      options.password,
      options.level,
      options.volumeSize,
    );
    await run7z(js7z, [...args, ...excludeArgs], progress);

    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

    if (options.volumeSize) {
      writeVolumeFiles(js7z, OUTPUT_DIR, options.outputPath);
    } else {
      const data = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      fs.writeFileSync(options.outputPath, Buffer.from(data));
    }

    logger.info({ event: "compress.wasm.complete", outputPath: options.outputPath });
  } finally {
    disposeJS7z(js7z);
  }
}
