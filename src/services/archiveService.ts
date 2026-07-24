/**
 * ArchiveService — unified engine-agnostic API for archive operations.
 *
 * All webview handlers (router.ts) should go through this service instead
 * of calling engine functions directly. Engine selection (system 7z vs WASM)
 * is handled internally.
 *
 * @module services/archiveService
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { compressWith7z, decompressWith7z, isEncrypted } from "../engines/js7z-engine";
import { COMPRESS_FORMATS } from "../constants";
import { logger } from "../utils/logger";
import { fetchFileList } from "../providers/fileListing";
import { extractSelected } from "../providers/extraction";
import { previewFileFromArchive, testArchive } from "../providers/archive/modify";
import {
  addToArchive,
  deleteFromArchive,
  renameInArchive,
  createFolderInArchive,
} from "../providers/archive";
import type { CompressOptions, DecompressOptions } from "../types";

export interface ArchiveServiceContext {
  filePath: string;
  password?: string;
}

// oxlint-disable-next-line typescript/no-extraneous-class
export class ArchiveService {
  /** Run compress with cancellation support */
  static async compress(
    options: CompressOptions,
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
    excludePatterns?: string[],
  ): Promise<void> {
    return compressWith7z(options, progress, token, excludePatterns);
  }

  /** Run full decompress with cancellation support */
  static async decompress(
    options: DecompressOptions,
    progress?: vscode.Progress<{ message?: string }>,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    return decompressWith7z(options, progress, token);
  }

  /** List files in an archive */
  static async list(
    filePath: string,
    password?: string,
  ): Promise<{ path: string; size: number; type: string }[]> {
    return fetchFileList(filePath, password ?? "");
  }

  /** Check if an archive is encrypted */
  static async detectEncryption(filePath: string): Promise<boolean> {
    return isEncrypted(filePath);
  }

  /** Selective extraction */
  static async extractSelectedFiles(
    archivePath: string,
    paths: string[],
    password?: string,
    flat?: boolean,
    outputOverride?: string,
    excludes?: string[],
  ): Promise<void> {
    return extractSelected(archivePath, paths, password, flat, outputOverride, excludes);
  }

  /** Preview a single file from archive */
  static async preview(archivePath: string, filePath: string, password?: string): Promise<void> {
    return previewFileFromArchive(archivePath, filePath, password);
  }

  /** Test archive integrity */
  static async test(archivePath: string, password?: string): Promise<string> {
    return testArchive(archivePath, password);
  }

  /** Add files to archive */
  static async add(
    archivePath: string,
    localPaths: string[],
    targetDir: string,
    password?: string,
  ): Promise<void> {
    return addToArchive(archivePath, localPaths, targetDir, password);
  }

  /** Delete entries from archive */
  static async delete(archivePath: string, paths: string[], password?: string): Promise<void> {
    return deleteFromArchive(archivePath, paths, password);
  }

  /** Rename an entry in archive */
  static async rename(
    archivePath: string,
    oldPath: string,
    newPath: string,
    password?: string,
  ): Promise<void> {
    return renameInArchive(archivePath, oldPath, newPath, password);
  }

  /** Create a folder in archive */
  static async createFolder(
    archivePath: string,
    targetDir: string,
    folderName: string,
    password?: string,
  ): Promise<void> {
    return createFolderInArchive(archivePath, targetDir, folderName, password);
  }

  /** Convert archive format (decompress + recompress) */
  static async convert(
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
}
