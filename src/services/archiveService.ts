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
import { COMPRESS_FORMATS } from "../constants";
import { logger } from "../utils/logger";

/**
 * Convert an archive format (decompress + recompress).
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
    if (volumeSize) {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    }
    const entries = fs.readdirSync(tmp).map((e) => ({ fsPath: path.join(tmp, e) }));
    const fmtInfo = COMPRESS_FORMATS.find((f) => f.label === dstFormat);
    await compressWith7z(
      {
        targets: entries.length ? entries : [{ fsPath: tmp }],
        format: fmtInfo ?? {
          label: dstFormat,
          description: "",
          canCreate: true,
          supportsEncryption: false,
        },
        outputPath: dstPath,
        password: outputPassword ?? password,
        level: vscode.workspace
          .getConfiguration("smart-archive")
          .get<number>("defaultCompressionLevel", 5),
        volumeSize,
      },
      { report: () => {} },
      token,
    );
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { event: "service.convert.cleanupFailed", err },
        "Failed to cleanup temp directory",
      );
    }
  }
}
