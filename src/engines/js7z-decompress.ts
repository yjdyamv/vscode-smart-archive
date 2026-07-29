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
import { snappyDecompressFile } from "./snappy-codec";
import { zstdDecompress } from "./zstd-codec";

/**
 * Shared helper for codec-based wrapped formats (brotli, lz4, zstd).
 * Decompresses the codec wrapper to a raw .tar temp file, then extracts
 * the tar into the output directory via WASM 7z, and finally triggers
 * inner-tar unwrapping.
 *
 * @param codecDecompress — callback that reads the archive input and
 *   writes the decompressed tar to the given temp path
 */
async function decompressCodecWrapper(
  options: DecompressOptions,
  progress: vscode.Progress<{ message?: string }> | undefined,
  token: vscode.CancellationToken | undefined,
  tmpPrefix: string,
  ext: string,
  codecDecompress: (input: string, tmpTar: string) => Promise<void>,
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  checkArchiveInputSize(options.inputPath);
  prog.report({ message: t("decompress.unwrapTar") });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const tmpTar = path.join(tmpDir, path.basename(options.inputPath, ext) + ".tar");
  try {
    await codecDecompress(options.inputPath, tmpTar);
    const js7z = await JS7z();
    try {
      const tarFsPath = streamToVFS(js7z, tmpTar);
      // Always extract into in-memory OUTPUT_DIR and copy out via
      // copyDirFromFS, which enforces the Zip-Slip / symlink / size-cap
      // guards. (A former NODEFS-mount fast-path keyed off a "/mnt_" VFS
      // prefix that is only ever derived from the archive's own filename,
      // so a "mnt_"-named archive could route extraction straight to disk
      // and bypass every guard — removed.)
      js7z.FS.mkdir(OUTPUT_DIR);
      prog.report({ message: t("decompress.inProgress") });
      await run7z(js7z, ["x", tarFsPath, `-o${OUTPUT_DIR}`], progress);
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);
    } finally {
      disposeJS7z(js7z);
    }
    logger.info({ event: "decompress.complete", outputDir: options.outputDir });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      logger.warn({ event: "decompress.cleanup.failed" }, "Failed to clean up temp directory");
    }
  }
  await unwrapInnerTar(options.outputDir, progress);
}

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

  // Note: unlike compress, we don't skip system 7z for encrypted
  // archives here. WASM decompression of password-protected files has
  // a known copyDirFromFS issue (separate bug). The password risk on
  // decompress is the same (CLI exposure), but the user already knows
  // the password — it was just entered — so the window is narrow.
  if (hasSystem7zForFormat(getFullExt(options.inputPath), true)) {
    logger.info({ event: "decompress.usingSystem7z" });
    await decompressWithSystem7z(options, progress, token);
    await unwrapInnerTar(options.outputDir, progress);
    return;
  }

  // All WASM paths below copy extracted entries into outputDir via
  // copyDirFromFS, which requires the directory to exist. The system-7z engine
  // creates it itself; here we must ensure it exists.
  fs.mkdirSync(options.outputDir, { recursive: true });

  const ext = getFullExt(options.inputPath);

  // ── Codec-based wrapped formats (brotli, lz4, zstd) ──
  // Each must first decompress the codec wrapper to produce a raw
  // .tar file, then extract that tar via WASM 7z.
  if (getWrapExtension(ext) === "br") {
    await decompressCodecWrapper(options, progress, token, "sab_", ext, (input, tmpTar) =>
      brotliDecompressFile(input, tmpTar),
    );
    return;
  }

  if (getWrapExtension(ext) === "lz4") {
    await decompressCodecWrapper(options, progress, token, "sal_", ext, (input, tmpTar) =>
      lz4DecompressFile(input, tmpTar),
    );
    return;
  }

  if (getWrapExtension(ext) === "sz") {
    await decompressCodecWrapper(options, progress, token, "sas_", ext, (input, tmpTar) =>
      snappyDecompressFile(input, tmpTar),
    );
    return;
  }

  if (getWrapExtension(ext) === "zst") {
    await decompressCodecWrapper(options, progress, token, "saz_", ext, async (input, tmpTar) => {
      const compressedData = new Uint8Array(fs.readFileSync(input));
      const decompressed = await zstdDecompress(compressedData);
      fs.writeFileSync(tmpTar, Buffer.from(decompressed));
    });
    return;
  }

  prog.report({ message: t("decompress.initEngine") });

  const js7z = await JS7z();

  try {
    checkArchiveInputSize(options.inputPath);
    const archiveFsPath = streamToVFS(js7z, options.inputPath);

    // Extract into in-memory OUTPUT_DIR, then copy out via copyDirFromFS so the
    // Zip-Slip / symlink / size-cap guards always run. (Removed a NODEFS-mount
    // fast-path whose "/mnt_" trigger was derived from the archive filename and
    // let a "mnt_"-named archive write straight to disk, bypassing the guards.)
    js7z.FS.mkdir(OUTPUT_DIR);

    const extractArgs: string[] = ["x", archiveFsPath, `-o${OUTPUT_DIR}`];
    if (options.password) {
      validatePassword(options.password);
      extractArgs.splice(1, 0, `-p${options.password}`);
    }

    prog.report({ message: t("decompress.inProgress") });

    await run7z(js7z, extractArgs, progress);
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);

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
    ".tar.sz",
    ".tgz",
    ".tbz2",
    ".tbz",
    ".txz",
    ".tzst",
    ".tsz",
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
      const tarStat = fs.statSync(tarPath);
      checkFileSize(tarStat.size);
      const js7z = await JS7z();

      try {
        const innerFsPath = streamToVFS(js7z, tarPath);
        // Extract into in-memory /_inner_out and copy out via copyDirFromFS so
        // the Zip-Slip / symlink / size-cap guards always run. (Removed a
        // NODEFS-mount fast-path whose "/mnt_" trigger came from the tar entry
        // name, letting an inner tar named "mnt_*" bypass the guards.)
        const outPath = "/_inner_out";
        js7z.FS.mkdir(outPath);

        await run7z(js7z, ["x", innerFsPath, `-o${outPath}`], progress);
        totalSize = checkTotalSize(totalSize, copyDirFromFS(js7z, outPath, outputDir));

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
