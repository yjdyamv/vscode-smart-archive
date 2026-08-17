/**
 * File listing core — Smart Archiver VSCode Extension
 *
 * Vscode-free file listing for archives, runs inside the worker thread.
 * Wrapped formats (tar.gz etc.) require full extraction to list.
 * Host dispatcher: providers/fileListing.ts.
 *
 * @module engines/fileListing-core
 */

import * as fs from "fs";
import * as path from "path";
import type { JS7zInstance } from "../types";
import { fixArchiveEncoding } from "../utils/path";
import { listFilesWasm } from "./js7z-list-core";
import { checkArchiveInputSize } from "./vfs-io";
import {
  getFullExt,
  isWrappedFormat,
  isEncryptableExt,
  VFS_CHUNK,
  VFS_TMP_LX,
  VFS_TMP_LS,
} from "../constants";
import { logger } from "../utils/logger-core";
import { disposeJS7z } from "./js7z-lifecycle";
import { validatePassword } from "../utils/security";
import { t } from "../i18n";
import { isNotAnArchiveError } from "../utils/errors";
import { JS7z } from "./js7z-factory";
import { brotliDecompress } from "./brotli-codec";
import { lz4Decompress } from "./lz4-codec";
import { snappyDecompress } from "./snappy-codec";

/**
 * Write a potentially large Uint8Array to VFS in chunks to avoid
 * hitting WASM memory limits with a single FS.writeFile call.
 */
export function writeLargeVFS(js7z: JS7zInstance, vfsPath: string, data: Uint8Array): void {
  const CHUNK = VFS_CHUNK;
  const name = vfsPath.replace(/^\//, "");
  js7z.FS.createDataFile("/", name, new Uint8Array(0), true, true, 0o777);
  const stream = js7z.FS.open(vfsPath, "w");
  try {
    for (let pos = 0; pos < data.length; pos += CHUNK) {
      const end = Math.min(pos + CHUNK, data.length);
      const chunk = data.subarray(pos, end);
      js7z.FS.write(stream, chunk, 0, chunk.length, pos);
    }
  } finally {
    js7z.FS.close(stream);
  }
}

export interface ListEntry {
  path: string;
  size: number;
  type: string;
}

/**
 * Fetch the file list for an archive.
 *
 * Strategy (ordered by priority):
 *   1. Wrapped formats (tar.gz etc.) — must extract to list (7z l doesn't traverse)
 *   2. js7z l -slt — preferred: reliable UTF-8 output, fast, detects encryption
 *   3. Encryptable format without password — return [ ] to trigger password prompt
 */
export async function fetchFileListCore(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<ListEntry[]> {
  const ext = getFullExt(filePath);
  if (isWrappedFormat(ext)) return listViaExtract(filePath, password, data);
  try {
    const f = await listFilesWasm(filePath, password, data);
    if (f && f.length > 0) return f;
  } catch (err) {
    if (isNotAnArchiveError(err)) {
      // When a password is provided, `can not open` is almost always
      // a wrong-password / encryption issue, not a split-volume issue.
      if (!password) {
        const wrapped = new Error(t("decompress.missingVolumes"), { cause: err });
        throw wrapped;
      }
    }
    logger.warn({ event: "fileListing.listFiles.failed", err, filePath }, "js7z listing failed");
  }
  if (!password && isEncryptableExt(ext)) return [];
  return [];
}

/**
 * Extract an inner tar to VFS and read all entries — avoids
 * 7z l -slt which doesn't support ustar prefix / LongLink in WASM.
 */
export async function extractAndList(tarName: string, tarData: Uint8Array): Promise<ListEntry[]> {
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    writeLargeVFS(js7z, `/${tarName}`, tarData);
    js7z.FS.mkdir(VFS_TMP_LX);
    const args = ["x", `/${tarName}`, "-o/_lx", "-y"];
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => {
        if (c === 0) resolve();
        else reject(new Error(`7z x: ${c}`));
      };
      js7z.callMain(args);
    });
    js7z.FS.readdir(VFS_TMP_LX).filter((e: string) => e !== "." && e !== "..");
    return readDirEntries(js7z, VFS_TMP_LX, "");
  } finally {
    disposeJS7z(js7z);
  }
}

export async function listViaExtract(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<ListEntry[]> {
  checkArchiveInputSize(filePath);
  const ext = getFullExt(filePath);
  const buf = data ?? fs.readFileSync(filePath);
  const archiveName = path.basename(filePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });

  try {
    // LZ4 is unwrapped by the codec engine (native first, WASM fallback),
    // then the inner tar is extracted to VFS and read — unified with the
    // generic path below. Avoids 7z l -slt which doesn't support ustar
    // prefix / LongLink in WASM.
    if (ext === ".tar.lz4" || ext === ".tlz4") {
      const innerTar = await lz4Decompress(buf);
      const innerName = path.basename(filePath, ext) + ".tar";
      logger.info({ event: "fileListing.extract.lz4", size: innerTar.length });
      return extractAndList(innerName, innerTar);
    }

    if (ext === ".tar.br" || ext === ".tbr") {
      const innerTar = await brotliDecompress(new Uint8Array(buf));
      const innerName = path.basename(filePath, ext) + ".tar";
      logger.info({ event: "fileListing.extract.brotli", size: innerTar.length });
      return extractAndList(innerName, innerTar);
    }

    if (ext === ".tar.sz" || ext === ".tsz") {
      const innerTar = await snappyDecompress(new Uint8Array(buf));
      const innerName = path.basename(filePath, ext) + ".tar";
      logger.info({ event: "fileListing.extract.snappy", size: innerTar.length });
      return extractAndList(innerName, innerTar);
    }

    js7z.FS.writeFile(`/${archiveName}`, buf);
    js7z.FS.mkdir(VFS_TMP_LS);
    const args = ["x", `/${archiveName}`, "-o/_ls", "-y"];
    if (password) {
      validatePassword(password);
      args.splice(1, 0, `-p${password}`);
    }
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`7z x: ${code}`));
      };
      js7z.callMain(args);
    });
    const topEntries = js7z.FS.readdir(VFS_TMP_LS).filter((e: string) => e !== "." && e !== "..");

    // Wrapped formats: if extraction produced a single .tar, list its contents.
    // Also handle the case where 7z auto-unpacks the inner tar — the .tar is an
    // intermediate artifact that should be hidden from the tree.
    const tarEntries = topEntries.filter((e) => e.endsWith(".tar"));
    const nonTar = topEntries.filter((e) => !e.endsWith(".tar"));

    if (tarEntries.length === 1 && nonTar.length === 0) {
      // Pure wrapped: one .tar file, no auto-unpack — extract and list contents
      const innerTar = tarEntries[0];
      const innerData = js7z.FS.readFile(`${VFS_TMP_LS}/${innerTar}`, { encoding: "binary" });
      return extractAndList(innerTar, new Uint8Array(innerData));
    }

    // Mixed: 7z auto-unpacked — return non-tar entries only
    return readDirEntries(js7z, VFS_TMP_LS, "");
  } finally {
    disposeJS7z(js7z);
  }
}

export function readDirEntries(
  js7z: JS7zInstance,
  dir: string,
  prefix: string,
  skipNames?: string[],
): ListEntry[] {
  const results: ListEntry[] = [];
  const entries = js7z.FS.readdir(dir);
  const skip = new Set(skipNames ?? []);
  for (const name of entries) {
    if (name === "." || name === ".." || skip.has(name)) continue;
    const fp = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const childPath = prefix ? `${prefix}/${name}` : name;
    const fixedPath = fixArchiveEncoding(childPath);
    try {
      const st = js7z.FS.stat(fp);
      if (js7z.FS.isDir(st.mode)) {
        results.push({ path: fixedPath, size: 0, type: "DIRECTORY" });
        results.push(...readDirEntries(js7z, fp, childPath, skipNames));
      } else {
        results.push({ path: fixedPath, size: st.size || 0, type: "REGULAR_FILE" });
      }
    } catch {
      logger.warn({ event: "fileListing.readDir.stat.failed" }, "Failed to stat virtual FS entry");
      results.push({ path: fixedPath, size: 0, type: "REGULAR_FILE" });
    }
  }
  return results;
}
