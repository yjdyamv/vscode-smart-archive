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
import * as os from "os";
import * as vscode from "vscode";
import type { DecompressOptions } from "../types";
import { disposeJS7z, OUTPUT_DIR, run7z } from "./js7z-helpers";
import { streamToVFS, checkArchiveInputSize } from "./vfs-io";
import { copyDirFromFS } from "../utils/fs";
import { t } from "../i18n";
import { logger } from "../utils/logger";
import { checkTotalSize, checkFileSize, validatePassword } from "../utils/security";
import { JS7z } from "./js7z-factory";
import { hasSystem7zForFormat, decompressWithSystem7z } from "./system7z";
import { getFullExt, getWrapExtension } from "../constants";
import { brotliDecompressFile } from "./brotli-codec";
import { lz4DecompressFile } from "./lz4-codec";
import { zstdDecompress } from "./zstd-codec";

export async function decompressWith7z(
  options: DecompressOptions,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  logger.info({
    event: "decompress.start",
    inputPath: options.inputPath,
    outputDir: options.outputDir,
  });

  if (hasSystem7zForFormat(getFullExt(options.inputPath), true)) {
    logger.info({ event: "decompress.usingSystem7z" });
    await decompressWithSystem7z(options, progress, token);
    await unwrapInnerTar(options.outputDir, progress);
    return;
  }

  const ext = getFullExt(options.inputPath);
  if (getWrapExtension(ext) === "br") {
    checkArchiveInputSize(options.inputPath);
    prog.report({ message: t("decompress.unwrapTar") });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sab_"));
    const tmpTar = path.join(tmpDir, path.basename(options.inputPath, ext) + ".tar");
    try {
      await brotliDecompressFile(options.inputPath, tmpTar);
      const js7z = await JS7z();
      try {
        const tarFsPath = streamToVFS(js7z, tmpTar);
        const usesMount = tarFsPath.startsWith("/mnt_");
        let outPath: string;
        if (usesMount) {
          outPath = "/out_mnt";
          js7z.FS.mkdir(outPath);
          js7z.FS.mount(js7z.NODEFS, { root: options.outputDir }, outPath);
        } else {
          js7z.FS.mkdir(OUTPUT_DIR);
          outPath = OUTPUT_DIR;
        }
        prog.report({ message: t("decompress.inProgress") });
        await run7z(js7z, ["x", tarFsPath, `-o${outPath}`], progress);
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (!usesMount) {
          copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);
        }
      } finally {
        disposeJS7z(js7z);
      }
      logger.info({ event: "decompress.complete", outputDir: options.outputDir });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    return;
  }

  if (getWrapExtension(ext) === "lz4") {
    checkArchiveInputSize(options.inputPath);
    prog.report({ message: t("decompress.unwrapTar") });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sal_"));
    const tmpTar = path.join(tmpDir, path.basename(options.inputPath, ext) + ".tar");
    try {
      await lz4DecompressFile(options.inputPath, tmpTar);
      const js7z = await JS7z();
      try {
        const tarFsPath = streamToVFS(js7z, tmpTar);
        const usesMount = tarFsPath.startsWith("/mnt_");
        let outPath: string;
        if (usesMount) {
          outPath = "/out_mnt";
          js7z.FS.mkdir(outPath);
          js7z.FS.mount(js7z.NODEFS, { root: options.outputDir }, outPath);
        } else {
          js7z.FS.mkdir(OUTPUT_DIR);
          outPath = OUTPUT_DIR;
        }
        prog.report({ message: t("decompress.inProgress") });
        await run7z(js7z, ["x", tarFsPath, `-o${outPath}`], progress);
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (!usesMount) {
          copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);
        }
      } finally {
        disposeJS7z(js7z);
      }
      logger.info({ event: "decompress.complete", outputDir: options.outputDir });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    return;
  }

  if (getWrapExtension(ext) === "zst") {
    checkArchiveInputSize(options.inputPath);
    prog.report({ message: t("decompress.unwrapTar") });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saz_"));
    const tmpTar = path.join(tmpDir, path.basename(options.inputPath, ext) + ".tar");
    try {
      const compressedData = new Uint8Array(fs.readFileSync(options.inputPath));
      const decompressed = await zstdDecompress(compressedData);
      fs.writeFileSync(tmpTar, Buffer.from(decompressed));
      const js7z = await JS7z();
      try {
        const tarFsPath = streamToVFS(js7z, tmpTar);
        const usesMount = tarFsPath.startsWith("/mnt_");
        let outPath: string;
        if (usesMount) {
          outPath = "/out_mnt";
          js7z.FS.mkdir(outPath);
          js7z.FS.mount(js7z.NODEFS, { root: options.outputDir }, outPath);
        } else {
          js7z.FS.mkdir(OUTPUT_DIR);
          outPath = OUTPUT_DIR;
        }
        prog.report({ message: t("decompress.inProgress") });
        await run7z(js7z, ["x", tarFsPath, `-o${outPath}`], progress);
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (!usesMount) {
          copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);
        }
      } finally {
        disposeJS7z(js7z);
      }
      logger.info({ event: "decompress.complete", outputDir: options.outputDir });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    return;
  }

  prog.report({ message: t("decompress.initEngine") });

  const js7z = await JS7z();

  try {
    checkArchiveInputSize(options.inputPath);
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

    prog.report({ message: t("decompress.inProgress") });

    await run7z(js7z, extractArgs, progress);
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    if (!usesMount) {
      copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);
    }

    await unwrapInnerTar(options.outputDir, progress);
    logger.info({ event: "decompress.complete", outputDir: options.outputDir });
  } finally {
    disposeJS7z(js7z);
  }
}

async function unwrapInnerTar(
  outputDir: string,
  progress?: vscode.Progress<{ message?: string }>,
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  const tarPatterns = [
    ".tar",
    ".tar.gz",
    ".tar.bz2",
    ".tar.xz",
    ".tar.zst",
    ".tar.lz",
    ".tar.lzma",
    ".tar.lz4",
    ".tgz",
    ".tbz2",
    ".tbz",
    ".txz",
    ".tzst",
    ".tlz",
    ".tlz4",
  ];

  let entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");

  logger.info({ event: "decompress.unwrapTar.start", outputDir });

  if (entries.length === 0) {
    logger.info({ event: "decompress.unwrapTar.noEntries", outputDir });
    return;
  }

  let depth = 0;
  let totalSize = 0;
  let tarCount = 0;
  const maxDepth = 3;
  const maxTarFiles = 100;

  while (depth < maxDepth) {
    depth++;
    const tarFiles = entries.filter((e) => tarPatterns.some((ext) => e.endsWith(ext)));
    if (tarFiles.length === 0) {
      logger.info({ event: "decompress.unwrapTar.noTarFound", outputDir, depth });
      break;
    }

    for (const tarFile of tarFiles) {
      tarCount++;
      if (tarCount > maxTarFiles) {
        logger.warn(
          { event: "decompress.unwrapTar.tooManyTars", tarCount, maxTarFiles },
          "Too many inner tar files, stopping unwrap",
        );
        return;
      }
      const tarPath = path.join(outputDir, tarFile);
      prog.report({ message: t("decompress.unwrapTar") });

      // Only validate file size, not counting towards total — the extracted
      // contents are counted below via copyDirFromFS to avoid double-counting.
      checkFileSize(fs.statSync(tarPath).size);
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
          totalSize = checkTotalSize(totalSize, copyDirFromFS(js7z, "/_inner_out", outputDir));
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
        disposeJS7z(js7z);
      }
    }

    entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");
  }
}
