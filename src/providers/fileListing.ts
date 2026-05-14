/**
 * File listing — Smart Archive VSCode Extension
 *
 * Engine-agnostic file listing for archives. Uses js7z-tools.
 * Wrapped formats (tar.gz etc.) require full extraction to list.
 *
 * @module providers/fileListing
 */

import * as vscode from "vscode";
import * as path from "path";
import type { JS7zInstance } from "../types";
import { listFiles } from "../engines/js7z-engine";
import { getFullExt, isWrappedFormat, isEncryptableExt } from "../constants";
import { logger } from "../utils/logger";
import { tryCleanup } from "../engines/js7z-helpers";
import { parse7zListing } from "../utils/parse7z";
import { validatePassword } from "../utils/security";
import { t } from "../i18n";
import { isNotAnArchiveError } from "../utils/errors";
import { JS7z } from "../engines/js7z-factory";

let _lz4js: { decompress: (data: Uint8Array) => Uint8Array } | null = null;

function getLz4js(): { decompress: (data: Uint8Array) => Uint8Array } {
  if (!_lz4js) {
    _lz4js = require("lz4js") as { decompress: (data: Uint8Array) => Uint8Array };
  }
  return _lz4js;
}

/**
 * Write a potentially large Uint8Array to VFS in chunks to avoid
 * hitting WASM memory limits with a single FS.writeFile call.
 */
function writeLargeVFS(js7z: JS7zInstance, vfsPath: string, data: Uint8Array): void {
  const CHUNK = 100 * 1024 * 1024; // 100MB
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

/**
 * Fetch the file list for an archive.
 *
 * Strategy (ordered by priority):
 *   1. Wrapped formats (tar.gz etc.) — must extract to list (7z l doesn't traverse)
 *   2. js7z l -slt — preferred: reliable UTF-8 output, fast, detects encryption
 *   3. Encryptable format without password — return [ ] to trigger password prompt
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
    if (isNotAnArchiveError(err)) {
      const wrapped = new Error(t("decompress.missingVolumes"));
      (wrapped as any).cause = err;
      throw wrapped;
    }
    logger.warn({ event: "fetchFileList.listFiles.failed", err, filePath }, "js7z listing failed");
  }
  if (!password && isEncryptableExt(ext)) return [];
  return [];
}

async function listViaExtract(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<{ path: string; size: number; type: string }[]> {
  const ext = getFullExt(filePath);
  const buf = data ?? (await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)));
  const archiveName = path.basename(filePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });

  try {
    // js7z WASM doesn't support LZ4 decompression. Decompress manually,
    // then feed the inner tar to 7z for listing.
    if (ext === ".tar.lz4" || ext === ".tlz4") {
      const innerTar = getLz4js().decompress(Buffer.from(buf));
      const innerName = path.basename(filePath, ext) + ".tar";
      logger.info({ event: "listViaExtract.lz4Decompressed", size: innerTar.length });

      // Write inner tar to VFS in chunks (100MB at a time) to stay within
      // WASM memory limits for multi-GB archives.
      writeLargeVFS(js7z, `/${innerName}`, innerTar);
      js7z.FS.mkdir("/_ls");
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (c: number) => {
          if (c === 0) resolve();
          else reject(new Error(`7z x inner tar: ${c}`));
        };
        js7z.callMain(["x", `/${innerName}`, "-o/_ls", "-y"]);
      });

      const topEntries = js7z.FS.readdir("/_ls").filter((e: string) => e !== "." && e !== "..");
      return readDirEntries(js7z, "/_ls", "", topEntries);
    }

    js7z.FS.writeFile(`/${archiveName}`, buf);
    js7z.FS.mkdir("/_ls");
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
    const topEntries = js7z.FS.readdir("/_ls").filter((e: string) => e !== "." && e !== "..");

    // Wrapped formats: if extraction produced a single .tar, list its contents.
    // Also handle the case where 7z auto-unpacks the inner tar — the .tar is an
    // intermediate artifact that should be hidden from the tree.
    const tarEntries = topEntries.filter((e) => e.endsWith(".tar"));
    const nonTar = topEntries.filter((e) => !e.endsWith(".tar"));

    if (tarEntries.length === 1 && nonTar.length === 0) {
      // Pure wrapped: one .tar file, no auto-unpack — list inner tar contents
      const innerTar = tarEntries[0];
      const innerData = js7z.FS.readFile(`/_ls/${innerTar}`, { encoding: "binary" });
      let stdout = "";
      let stderr = "";
      const js7z2 = await JS7z({
        print: (text: string) => {
          stdout += text + "\n";
        },
        printErr: (text: string) => {
          stderr += text + "\n";
        },
      });
      try {
        js7z2.FS.writeFile(`/${innerTar}`, new Uint8Array(innerData));
        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (code: number) => {
            if (code === 0) resolve();
            else reject(new Error(`7z l inner tar: ${code}\n${stderr}`));
          };
          js7z2.callMain(["l", "-slt", "-sccUTF-8", `/${innerTar}`]);
        });
        return parse7zListing(stdout, innerTar);
      } finally {
        tryCleanup(js7z2);
      }
    }

    // Mixed: 7z auto-unpacked — return non-tar entries only
    const entries = nonTar.length > 0 ? nonTar : tarEntries;
    return readDirEntries(js7z, "/_ls", "", entries);
  } finally {
    tryCleanup(js7z);
  }
}

function readDirEntries(
  js7z: JS7zInstance,
  dir: string,
  prefix: string,
  skipNames?: string[],
): { path: string; size: number; type: string }[] {
  const results: { path: string; size: number; type: string }[] = [];
  const entries = js7z.FS.readdir(dir);
  const skip = new Set(skipNames ?? []);
  for (const name of entries) {
    if (name === "." || name === ".." || skip.has(name)) continue;
    const fp = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const childPath = prefix ? `${prefix}/${name}` : name;
    try {
      const st = js7z.FS.stat(fp);
      if (js7z.FS.isDir(st.mode)) {
        results.push({ path: childPath, size: 0, type: "DIRECTORY" });
        results.push(...readDirEntries(js7z, fp, childPath, skipNames));
      } else {
        results.push({ path: childPath, size: st.size || 0, type: "REGULAR_FILE" });
      }
    } catch {
      logger.warn({ event: "readDirEntries.stat.failed" }, "Failed to stat virtual FS entry");
      results.push({ path: childPath, size: 0, type: "REGULAR_FILE" });
    }
  }
  return results;
}

export {
  JS7z,
  tryCleanup as tryCleanupJS7z,
  fetchFileList,
  listViaExtract,
  readDirEntries,
  parse7zListing,
};
