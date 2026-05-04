/**
 * Archive delete operations — Smart Archive VSCode Extension
 *
 * @module providers/archive/delete
 */

import * as vscode from "vscode";
import * as path from "path";
import { JS7z, tryCleanupJS7z } from "../fileListing";
import { streamToVFS } from "../../engines/js7z-helpers";
import { getFullExt, isWrappedFormat } from "../../constants";
import { checkFileSize, validatePassword } from "../../utils/security";
import { logger } from "../../utils/logger";
import { withWrappedArchive } from "./wrappedHelper";

export async function deleteFromArchive(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);

  if (isWrappedFormat(ext)) {
    logger.info({ event: "deleteFromArchive.wrapped", archivePath, ext });
    return deleteFromWrappedArchive(archivePath, selectedPaths, password);
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const archiveFsPath = streamToVFS(js7z, archivePath);

    const dArgs = ["d", archiveFsPath, "-y"];
    if (password) {
      validatePassword(password);
      dArgs.splice(1, 0, `-p${password}`);
    }
    dArgs.push(...selectedPaths.map((p) => p.replace(/\\/g, "/")));
    logger.debug({ event: "deleteFromArchive.7zArgs", args: dArgs.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d: ${c}`)));
      js7z.callMain(dArgs);
    });

    const updated = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
    logger.info({
      event: "deleteFromArchive.ok",
      archivePath,
      items: selectedPaths.length,
      newSizeBytes: updated.byteLength,
    });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));
  } finally {
    ;
    tryCleanupJS7z(js7z);
  }
}

async function deleteFromWrappedArchive(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
): Promise<void> {
  return withWrappedArchive(archivePath, password, async (js7z2) => {
    const dArgs = ["d", "/inner.tar", "-y"];
    if (password) {
      validatePassword(password);
      dArgs.splice(1, 0, `-p${password}`);
    }
    dArgs.push(...selectedPaths.map((p) => p.replace(/\\/g, "/")));
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d: ${c}`)));
      js7z2.callMain(dArgs);
    });
  });
}
