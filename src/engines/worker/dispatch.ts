/**
 * Operation dispatch — Smart Archiver VSCode Extension
 *
 * Single op → core mapping for the archive pipeline. Both execution
 * contexts cross the same seam: the worker handler (messages from the
 * host) and the in-process runner (tests / dev fallback, direct calls).
 * Before this module the switch was duplicated in both, so a new
 * ArchiveOp had to be wired twice and the two paths could drift.
 *
 * Vscode-free: cancellation/progress cross as TokenLike/ProgressLike.
 *
 * @module engines/worker/dispatch
 */

import type { ArchiveOp, RequestPayload } from "./types";
import type {
  CompressPayload,
  DecompressPayload,
  ListPayload,
  ModifyPayload,
  UnwrapPayload,
} from "./types";
import type { TokenLike, ProgressLike } from "../../utils/cancellation";
import { compressWith7z as compressCore } from "../js7z-compress-core";
import { decompressWith7z as decompressCore } from "../js7z-decompress-core";
import { unwrapInnerTar } from "../js7z-decompress-core";
import { fetchFileListCore } from "../fileListing-core";
import { isEncryptedWasm } from "../js7z-list-core";
import {
  addToArchiveCore,
  deleteFromArchiveCore,
  renameInArchiveCore,
  createFolderInArchiveCore,
  previewFileCore,
  testArchiveCore,
} from "../modify-core";
import { extractSelectedCore } from "../extract-core";

/**
 * Run an archive operation against the vscode-free core pipeline.
 * Returns the op result (e.g. the entry list for "list", the test verdict
 * for "test") or undefined for operations with no result.
 */
export async function dispatchOp(
  op: ArchiveOp,
  payload: RequestPayload,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<unknown> {
  switch (op) {
    case "compress": {
      const p = payload as CompressPayload;
      await compressCore(p.options, progress, token, p.excludePatterns);
      return;
    }
    case "decompress": {
      const p = payload as DecompressPayload;
      await decompressCore(p.options, progress, token);
      return;
    }
    case "list": {
      const p = payload as ListPayload;
      return fetchFileListCore(p.inputPath, p.password ?? "", p.data);
    }
    case "isEncrypted": {
      const p = payload as ListPayload;
      return isEncryptedWasm(p.inputPath);
    }
    case "unwrap": {
      const p = payload as UnwrapPayload;
      await unwrapInnerTar(p.outputDir, progress, token);
      return;
    }
    case "modify": {
      const p = payload as ModifyPayload;
      switch (p.action) {
        case "add":
          await addToArchiveCore(
            p.archivePath,
            p.localPaths,
            p.targetDir,
            p.password,
            p.excludePatterns,
            token,
          );
          return;
        case "delete":
          await deleteFromArchiveCore(p.archivePath, p.paths, p.password, token);
          return;
        case "rename":
          await renameInArchiveCore(p.archivePath, p.oldPath, p.newPath, p.password, token);
          return;
        case "createFolder":
          await createFolderInArchiveCore(
            p.archivePath,
            p.targetDir,
            p.folderName,
            p.password,
            token,
          );
          return;
        case "preview":
          await previewFileCore(p.archivePath, p.filePath, p.password, p.outputPath);
          return;
        case "test":
          return testArchiveCore(p.archivePath, p.password);
        case "extract":
          await extractSelectedCore(
            p.archivePath,
            p.paths,
            p.password,
            p.flat,
            p.outputDir,
            p.excludes,
            token,
          );
          return;
      }
    }
  }
}
