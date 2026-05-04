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
import type { JS7zFactory, CompressOptions, FormatInfo, JS7zInstance } from "../types";
import {
  tryCleanup,
  INPUT_DIR,
  OUTPUT_DIR,
  copyInputsToFS,
  streamToVFS,
  run7z,
} from "./js7z-helpers";
import { joinFSPath, getBaseName } from "../utils/path";
import { t, formatDuration } from "../i18n";
import { isWrappedFormat, getWrapExtension } from "../constants";
import { zstdCompressFile } from "./zstd-codec";
import { createTarFile } from "./tar-writer";
import { logger } from "../utils/logger";
import { validatePassword } from "../utils/security";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z: JS7zFactory = require("js7z-tools");

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
    args.push(`-v${volumeSize}`);
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
  progress: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
  excludePatterns?: string[],
): Promise<void> {
  const startTime = Date.now();
  progress.report({ message: t("compress.initEngine") });

  const js7z = await JS7z();

  // Convert gitignore patterns to 7z -xr! flags
  const excludeArgs = (excludePatterns ?? []).map((p) => "-xr!" + p.replace(/^(\*\*\/)+/, ""));

  try {
    js7z.FS.mkdir(INPUT_DIR);
    js7z.FS.mkdir(OUTPUT_DIR);

    progress.report({ message: t("compress.readingFiles") });
    const localPaths = options.targets.map((target) => target.fsPath);
    logger.info({
      event: "compress.start",
      format: options.format.label,
      files: localPaths.length,
      level: options.level,
    });

    const allInputPaths = copyInputsToFS(js7z, localPaths, token);
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    progress.report({ message: t("compress.addedItems", String(localPaths.length)) });

    const archiveName = getBaseName(options.outputPath);
    const archiveFsPath = joinFSPath(OUTPUT_DIR, archiveName);

    if (isWrappedFormat("." + options.format.label)) {
      const wrapExt = getWrapExtension("." + options.format.label);
      const tarDiskPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sat_")), "_tmp.tar");

      progress.report({ message: t("compress.creatingTar") });
      await createTarFile(
        tarDiskPath,
        options.targets.map((target) => target.fsPath),
        token,
      );
      if (token?.isCancellationRequested) throw new vscode.CancellationError();

      let compressedData: Uint8Array | undefined;
      if (wrapExt === "zst") {
        progress.report({ message: t("compress.compressingTar", wrapExt) });
        const zstOut = path.join(path.dirname(tarDiskPath), "_tmp.tar.zst");
        await zstdCompressFile(tarDiskPath, zstOut, options.level);
        compressedData = new Uint8Array(fs.readFileSync(zstOut));
      } else {
        progress.report({ message: t("compress.compressingTar", wrapExt) });
        const js7z2 = await JS7z();
        try {
          streamToVFS(js7z2, tarDiskPath, "/_tmp.tar");
          await run7z(js7z2, ["a", archiveFsPath, "/_tmp.tar", "-mmt=on"], progress);
          compressedData = new Uint8Array(js7z2.FS.readFile(archiveFsPath, { encoding: "binary" }));
        } finally {
          tryCleanup(js7z2);
        }
      }

      // Clean up temp tar
      try {
        fs.unlinkSync(tarDiskPath);
        fs.rmdirSync(path.dirname(tarDiskPath));
      } catch {}

      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      if (compressedData) {
        fs.writeFileSync(options.outputPath, Buffer.from(compressedData));
      }
      const elapsed = formatDuration(Date.now() - startTime);
      vscode.window.showInformationMessage(
        t("compress.done") + options.outputPath + t("time.elapsed", elapsed),
      );
      return;
    }

    const args = buildCompressArgs(
      archiveFsPath,
      allInputPaths,
      options.format,
      options.password,
      options.level,
      options.volumeSize,
    );
    await run7z(js7z, [...args, ...excludeArgs], progress);

    if (options.volumeSize) {
      writeVolumeFiles(js7z, OUTPUT_DIR, options.outputPath);
    } else {
      const data = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      fs.writeFileSync(options.outputPath, Buffer.from(data));
    }
    const elapsed = formatDuration(Date.now() - startTime);
    vscode.window.showInformationMessage(
      t("compress.done") + options.outputPath + t("time.elapsed", elapsed),
    );
  } finally {
    tryCleanup(js7z);
  }
}
