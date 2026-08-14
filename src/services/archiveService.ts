/**
 * Archive conversion — Smart Archive VSCode Extension
 *
 * Convert an archive between formats (decompress to a temp dir, then
 * recompress). Used by the webview convert / encrypt / decrypt / merge /
 * split handlers. All other engine operations go through the dispatchers
 * directly — this module exists only for the orchestrated two-step
 * conversion pipeline.
 *
 * @module services/archiveService
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { compressWith7z } from "../engines/js7z-compress";
import { decompressWith7z } from "../engines/js7z-decompress";
import { COMPRESS_FORMATS, DEFAULT_COMPRESSION_LEVEL } from "../constants";
import { withAtomicOutput } from "../utils/fs";
import { logger } from "../utils/logger";

/**
 * Convert an archive format (decompress + recompress).
 *
 * The output is written atomically (temp file in the destination directory,
 * renamed into place only on success): a failed or cancelled conversion can
 * never leave a corrupt partial archive at dstPath — important for merge
 * over a split-volume set, where dstPath is the logical source path.
 *
 * @param srcPath - Source archive
 * @param dstFormat - Target format label (e.g. "7z", "zip")
 * @param dstPath - Destination archive path
 * @param password - Source archive password
 * @param volumeSize - Optional split volume size (e.g. "100m")
 * @param outputPassword - Optional new password for the output (empty = keep source password)
 * @param token - Cancellation token
 */
export async function convertArchive(
  srcPath: string,
  dstFormat: string,
  dstPath: string,
  password: string,
  volumeSize?: string,
  outputPassword?: string,
  token?: vscode.CancellationToken,
  recoveryVolumeCount?: number,
): Promise<void> {
  logger.info({ event: "service.convert.start", srcPath, dstFormat, dstPath });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sa_cvt_"));
  try {
    await decompressWith7z(
      { inputPath: srcPath, outputDir: tmp, password },
      { report: () => {} },
      token,
    );
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    const entries = fs.readdirSync(tmp).map((e) => ({ fsPath: path.join(tmp, e) }));
    const fmtInfo = COMPRESS_FORMATS.find((f) => f.label === dstFormat);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    await withAtomicOutput({
      dstPath,
      volumeSize,
      write: async (outPath) => {
        await compressWith7z(
          {
            targets: entries.length ? entries : [{ fsPath: tmp }],
            format: fmtInfo ?? {
              label: dstFormat,
              description: "",
              canCreate: true,
              supportsEncryption: false,
            },
            outputPath: outPath,
            password: outputPassword ?? password,
            // RAR5 parity with the compress wizard: a password-protected
            // RAR output must encrypt headers too, otherwise member names
            // leak from an "encrypted" archive.
            encryptHeaders:
              dstFormat === "rar" && Boolean(outputPassword ?? password) ? true : undefined,
            level: vscode.workspace
              .getConfiguration("smart-archive")
              .get<number>("defaultCompressionLevel", DEFAULT_COMPRESSION_LEVEL),
            volumeSize,
            // RAR5 recovery volumes (.rev, WinRAR -rv): only meaningful for
            // split RAR output.
            recoveryVolumeCount:
              dstFormat === "rar" && volumeSize ? recoveryVolumeCount : undefined,
          },
          { report: () => {} },
          token,
        );
      },
    });
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { event: "service.convert.cleanup.failed", err },
        "Failed to cleanup temp directory",
      );
    }
  }
}
