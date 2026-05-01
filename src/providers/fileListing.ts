/**
 * File listing — Smart Archive VSCode Extension
 *
 * Engine-agnostic file listing for archives. Orchestrates between
 * js7z-tools and libarchive-wasm, handling wrapped formats (tar.gz etc.)
 * that require full extraction to list.
 *
 * @module providers/fileListing
 */

import * as vscode from "vscode";
import * as path from "path";
import type { JS7zFactory, JS7zInstance } from "../types";
import { listFiles } from "../engines/js7z-engine";
import { getFileList } from "../engines/libarchive-engine";
import { getFullExt, isWrappedFormat, isEncryptableExt } from "../constants";
import { logger } from "../utils/logger";
import { tryCleanup } from "../engines/js7z-helpers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z: JS7zFactory = require("js7z-tools");

/**
 * Fetch the file list for an archive, choosing the best engine.
 *
 * Strategy (ordered by priority):
 *   1. Wrapped formats (tar.gz etc.) — must extract to list (7z l doesn't traverse)
 *   2. js7z l -slt — preferred: reliable UTF-8 output, fast, detects encryption
 *   3. Encryptable format without password — return [ ] to trigger password prompt;
 *      intentionally skip libarchive fallback because it may leak file metadata
 *      without requiring the password
 *   4. libarchive getFileList — fallback for unsupported formats
 */
async function fetchFileList(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<{ path: string; size: number; type: string }[]> {
  const ext = getFullExt(filePath);
  if (isWrappedFormat(ext)) return listViaExtract(filePath, password, data);
  try {
    const f = await listFiles(filePath, password, data);
    if (f && f.length > 0) return f;
  } catch (err) {
    logger.warn(
      { event: "fetchFileList.listFiles.failed", err, filePath },
      "js7z listing failed, will try fallback",
    );
  }
  if (!password && isEncryptableExt(ext)) {
    try {
      const laEntries = await getFileList(filePath);
      if (laEntries && laEntries.length > 0) return laEntries;
    } catch {
      /* libarchive also failed */
    }
    return [];
  }
  return getFileList(filePath);
}

async function listViaExtract(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<{ path: string; size: number; type: string }[]> {
  const buf = data ?? (await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)));
  const archiveName = path.basename(filePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });

  try {
    js7z.FS.writeFile(`/${archiveName}`, buf);
    js7z.FS.mkdir("/_ls");
    const args = ["x", `/${archiveName}`, "-o/_ls", "-y"];
    if (password) args.splice(1, 0, `-p${password}`);
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`7z x: ${code}`));
      };
      js7z.callMain(args);
    });
    const topEntries = js7z.FS.readdir("/_ls").filter((e: string) => e !== "." && e !== "..");
    if (topEntries.length === 1 && topEntries[0].endsWith(".tar")) {
      const innerTar = topEntries[0];
      const innerData = js7z.FS.readFile(`/_ls/${innerTar}`, { encoding: "binary" });
      const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
      try {
        js7z2.FS.writeFile(`/${innerTar}`, new Uint8Array(innerData));
        js7z2.FS.mkdir("/_ls2");
        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (code: number) => {
            if (code === 0) resolve();
            else reject(new Error(`7z x inner tar: ${code}`));
          };
          js7z2.callMain(["x", `/${innerTar}`, "-o/_ls2", "-y"]);
        });
        return readDirEntries(js7z2, "/_ls2", "");
      } finally {
        tryCleanup(js7z2);
      }
    }
    return readDirEntries(js7z, "/_ls", "");
  } finally {
    tryCleanup(js7z);
  }
}

function readDirEntries(
  js7z: JS7zInstance,
  dir: string,
  prefix: string,
): { path: string; size: number; type: string }[] {
  const results: { path: string; size: number; type: string }[] = [];
  const entries = js7z.FS.readdir(dir);
  for (const name of entries) {
    if (name === "." || name === "..") continue;
    const fp = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const childPath = prefix ? `${prefix}/${name}` : name;
    try {
      const st = js7z.FS.stat(fp);
      if (js7z.FS.isDir(st.mode)) {
        results.push({ path: childPath, size: 0, type: "DIRECTORY" });
        results.push(...readDirEntries(js7z, fp, childPath));
      } else {
        results.push({ path: childPath, size: st.size || 0, type: "REGULAR_FILE" });
      }
    } catch {
      results.push({ path: childPath, size: 0, type: "REGULAR_FILE" });
    }
  }
  return results;
}

export { JS7z, tryCleanup as tryCleanupJS7z, fetchFileList, listViaExtract, readDirEntries };
