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
import type { JS7zFactory, CompressOptions, FormatInfo } from "../types";
import {
  tryCleanup,
  INPUT_DIR,
  OUTPUT_DIR,
  copyInputsToFS,
  mountLocalPaths,
  run7z,
  MAX_BUFFER,
} from "./js7z-helpers";
import { joinFSPath, getBaseName } from "../utils/path";
import { t, formatDuration } from "../i18n";
import { isWrappedFormat, getWrapExtension } from "../constants";
import { zstdCompress } from "./zstd-codec";
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
  args.push(...inputPaths);
  return args;
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

    // Copy small files/dirs to VFS, mount large files via NODEFS
    const { paths: mountedPaths, usesMount, mountedLocalPaths } = mountLocalPaths(js7z, localPaths);
    const smallPaths = localPaths.filter((lp) => !mountedLocalPaths.includes(lp));
    const fsInputPaths = copyInputsToFS(js7z, smallPaths, token);
    const allInputPaths = [...fsInputPaths, ...mountedPaths];
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    progress.report({ message: t("compress.addedItems", String(localPaths.length)) });

    const archiveName = getBaseName(options.outputPath);
    js7z.FS.mkdir(OUTPUT_DIR);
    const archiveFsPath = joinFSPath(OUTPUT_DIR, archiveName);

    if (isWrappedFormat("." + options.format.label)) {
      const wrapExt = getWrapExtension("." + options.format.label);
      const tarDiskPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sat_")), "_tmp.tar");

      progress.report({ message: t("compress.creatingTar") });
      await createTarFile(
        tarDiskPath,
        options.targets.map((t) => t.fsPath),
        token,
      );
      if (token?.isCancellationRequested) throw new vscode.CancellationError();

      let compressedData: Uint8Array | undefined;
      if (wrapExt === "zst") {
        const tarSize = fs.statSync(tarDiskPath).size;
        if (tarSize > MAX_BUFFER) {
          try {
            fs.unlinkSync(tarDiskPath);
            fs.rmdirSync(path.dirname(tarDiskPath));
          } catch {}
          throw new Error(
            "TAR exceeds 2 GiB — zstd compression not yet supported for large inputs",
          );
        }
        const tarData = fs.readFileSync(tarDiskPath);
        progress.report({ message: t("compress.compressingTar", wrapExt) });
        compressedData = await zstdCompress(new Uint8Array(tarData), options.level);
      } else {
        progress.report({ message: t("compress.compressingTar", wrapExt) });
        const js7z2 = await JS7z();
        try {
          js7z2.FS.mkdir("/_comp");
          js7z2.FS.mount(js7z2.NODEFS, { root: path.dirname(tarDiskPath) }, "/_comp");
          await run7z(js7z2, ["a", archiveFsPath, "/_comp/_tmp.tar", "-mmt=on"], progress);
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
    );
    await run7z(js7z, [...args, ...excludeArgs], progress);

    const data = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    fs.writeFileSync(options.outputPath, Buffer.from(data));
    const elapsed = formatDuration(Date.now() - startTime);
    vscode.window.showInformationMessage(
      t("compress.done") + options.outputPath + t("time.elapsed", elapsed),
    );
  } finally {
    tryCleanup(js7z);
  }
}
