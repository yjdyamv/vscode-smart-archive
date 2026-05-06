/**
 * js7z decompress — Smart Archive VSCode Extension
 *
 * Full decompression pipeline using js7z-tools: read archive to virtual FS,
 * run 7z x, copy results to local disk, and auto-unwrap inner .tar files.
 *
 * @module engines/js7z-decompress
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { DecompressOptions } from "../types";
import { tryCleanup, OUTPUT_DIR, run7z, streamToVFS } from "./js7z-helpers";
import { copyDirFromFS } from "../utils/fs";
import { t, formatDuration } from "../i18n";
import { logger } from "../utils/logger";
import { checkFileSize, checkTotalSize, validatePassword } from "../utils/security";
import { JS7z } from "./js7z-factory";

export async function decompressWith7z(
  options: DecompressOptions,
  progress: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  const startTime = Date.now();
  logger.info({
    event: "decompress.start",
    inputPath: options.inputPath,
    outputDir: options.outputDir,
  });
  progress.report({ message: t("decompress.initEngine") });

  const js7z = await JS7z();

  try {
    checkFileSize(fs.statSync(options.inputPath).size);
    const archiveFsPath = streamToVFS(js7z, options.inputPath);
    const usesMount = archiveFsPath.startsWith("/mnt_");

    let outPath: string;
    if (usesMount) {
      const outMnt = "/out_mnt";
      js7z.FS.mkdir(outMnt);
      js7z.FS.mount(js7z.NODEFS, { root: options.outputDir }, outMnt);
      outPath = outMnt;
    } else {
      js7z.FS.mkdir(OUTPUT_DIR);
      outPath = OUTPUT_DIR;
    }

    const extractArgs: string[] = ["x", archiveFsPath, `-o${outPath}`];
    if (options.password) {
      validatePassword(options.password);
      extractArgs.splice(1, 0, `-p${options.password}`);
    }

    progress.report({ message: t("decompress.inProgress") });

    await run7z(js7z, extractArgs, progress);
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    if (!usesMount) {
      copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);
    }

    await unwrapInnerTar(options.outputDir, progress);

    const elapsed = formatDuration(Date.now() - startTime);
    vscode.window.showInformationMessage(
      t("decompress.done") + options.outputDir + t("time.elapsed", elapsed),
    );
  } finally {
    tryCleanup(js7z);
  }
}

async function unwrapInnerTar(
  outputDir: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  const tarPatterns = [
    ".tar",
    ".tar.gz",
    ".tar.bz2",
    ".tar.xz",
    ".tar.zst",
    ".tar.lz",
    ".tar.lzma",
    ".tgz",
    ".tbz2",
    ".tbz",
    ".txz",
    ".tzst",
    ".tlz",
  ];

  let entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");

  if (entries.length === 0) return;

  let depth = 0;
  let totalSize = 0;
  const maxDepth = 3;

  while (depth < maxDepth) {
    depth++;
    const tarFiles = entries.filter((e) => tarPatterns.some((ext) => e.endsWith(ext)));
    if (tarFiles.length === 0) break;

    for (const tarFile of tarFiles) {
      const tarPath = path.join(outputDir, tarFile);
      progress.report({ message: t("decompress.unwrapTar") });

      checkFileSize(fs.statSync(tarPath).size);
      totalSize = checkTotalSize(totalSize, fs.statSync(tarPath).size);
      const js7z = await JS7z();

      try {
        const innerFsPath = streamToVFS(js7z, tarPath);
        const usesMount = innerFsPath.startsWith("/mnt_");
        let outPath: string;
        if (usesMount) {
          outPath = "/out_mnt_tar";
          js7z.FS.mkdir(outPath);
          js7z.FS.mount(js7z.NODEFS, { root: outputDir }, outPath);
        } else {
          outPath = "/_inner_out";
          js7z.FS.mkdir(outPath);
        }

        await run7z(js7z, ["x", innerFsPath, `-o${outPath}`], progress);
        if (!usesMount) {
          totalSize = copyDirFromFS(js7z, "/_inner_out", outputDir);
        }

        try {
          fs.unlinkSync(tarPath);
        } catch (err) {
          logger.warn(
            { event: "decompress.unlinkFailed", path: tarPath, err },
            "Failed to remove intermediate tar archive",
          );
        }
      } finally {
        tryCleanup(js7z);
      }
    }

    entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");
  }
}
