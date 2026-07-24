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
import { fixArchiveEncoding } from "../utils/path";
import { listFiles } from "../engines/js7z-engine";
import { getFullExt, isWrappedFormat, isEncryptableExt, VFS_CHUNK } from "../constants";
import { logger } from "../utils/logger";
import { disposeJS7z } from "../engines/js7z-lifecycle";
import { parse7zListing } from "../utils/parse7z";
import { validatePassword, checkFileSize, checkTotalSize } from "../utils/security";
import { t } from "../i18n";
import { isNotAnArchiveError } from "../utils/errors";
import { JS7z } from "../engines/js7z-factory";
import { brotliDecompress } from "../engines/brotli-codec";

let _lz4js: { decompress: (data: Uint8Array) => Uint8Array } | null = null;

function getLz4js(): { decompress: (data: Uint8Array) => Uint8Array } {
  if (!_lz4js) {
    _lz4js = require("lz4js") as { decompress: (data: Uint8Array) => Uint8Array };
  }
  return _lz4js;
}

/**
 * Decompress concatenated LZ4 frames into a single Uint8Array.
 * lz4js.decompress() handles one frame at a time; this loops until
 * all frames in the buffer are consumed.
 */
function decompressLz4Frames(compressed: Buffer): Uint8Array {
  const lz4js = getLz4js();
  const LZ4_MAGIC_BUF = Buffer.from([0x04, 0x22, 0x4d, 0x18]); // LZ4 frame magic in LE bytes
  const parts: Uint8Array[] = [];
  let totalDecompressed = 0;
  let offset = 0;
  while (offset < compressed.length) {
    // Use Buffer.indexOf for fast magic-byte scanning instead of byte-by-byte
    const magicIdx = compressed.indexOf(LZ4_MAGIC_BUF, offset);
    if (magicIdx < 0) break;
    offset = magicIdx;
    // Find end of this frame (next magic or EOF)
    const nextMagic = compressed.indexOf(LZ4_MAGIC_BUF, offset + 4);
    const end = nextMagic < 0 ? compressed.length : nextMagic;
    const frame = compressed.subarray(offset, end);
    const decompressed = lz4js.decompress(frame);
    totalDecompressed = checkTotalSize(totalDecompressed, decompressed.length);
    checkFileSize(decompressed.length);
    parts.push(decompressed);
    offset = end;
  }
  if (parts.length === 0) throw new Error("No LZ4 frames found");
  // Concatenate all parts
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

/**
 * Write a potentially large Uint8Array to VFS in chunks to avoid
 * hitting WASM memory limits with a single FS.writeFile call.
 */
function writeLargeVFS(js7z: JS7zInstance, vfsPath: string, data: Uint8Array): void {
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
      // When a password is provided, `can not open` is almost always
      // a wrong-password / encryption issue, not a split-volume issue.
      if (!password) {
        const wrapped = new Error(t("decompress.missingVolumes"), { cause: err });
        throw wrapped;
      }
    }
    logger.warn({ event: "fetchFileList.listFiles.failed", err, filePath }, "js7z listing failed");
  }
  if (!password && isEncryptableExt(ext)) return [];
  return [];
}

/**
 * Extract an inner tar to VFS and read all entries — avoids
 * 7z l -slt which doesn't support ustar prefix / LongLink in WASM.
 */
async function extractAndList(
  tarName: string,
  tarData: Uint8Array,
): Promise<{ path: string; size: number; type: string }[]> {
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    writeLargeVFS(js7z, `/${tarName}`, tarData);
    js7z.FS.mkdir("/_lx");
    const args = ["x", `/${tarName}`, "-o/_lx", "-y"];
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => {
        if (c === 0) resolve();
        else reject(new Error(`7z x: ${c}`));
      };
      js7z.callMain(args);
    });
    const topEntries = js7z.FS.readdir("/_lx").filter((e: string) => e !== "." && e !== "..");
    return readDirEntries(js7z, "/_lx", "", topEntries);
  } finally {
    disposeJS7z(js7z);
  }
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
    // Manually decompress the codec wrapper, then extract the inner tar
    // to VFS and read entries — unified with the generic path below.
    // Avoids 7z l -slt which doesn't support ustar prefix / LongLink in WASM.
    if (ext === ".tar.lz4" || ext === ".tlz4") {
      const innerTar = decompressLz4Frames(Buffer.from(buf));
      const innerName = path.basename(filePath, ext) + ".tar";
      logger.info({ event: "listViaExtract.lz4Decompressed", size: innerTar.length });
      return extractAndList(innerName, innerTar);
    }

    if (ext === ".tar.br" || ext === ".tbr") {
      const innerTar = brotliDecompress(new Uint8Array(buf));
      const innerName = path.basename(filePath, ext) + ".tar";
      logger.info({ event: "listViaExtract.brotliDecompressed", size: innerTar.length });
      return extractAndList(innerName, innerTar);
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
      // Pure wrapped: one .tar file, no auto-unpack — extract and list contents
      const innerTar = tarEntries[0];
      const innerData = js7z.FS.readFile(`/_ls/${innerTar}`, { encoding: "binary" });
      return extractAndList(innerTar, new Uint8Array(innerData));
    }

    // Mixed: 7z auto-unpacked — return non-tar entries only
    const entries = nonTar.length > 0 ? nonTar : tarEntries;
    return readDirEntries(js7z, "/_ls", "", entries);
  } finally {
    disposeJS7z(js7z);
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
      logger.warn({ event: "readDirEntries.stat.failed" }, "Failed to stat virtual FS entry");
      results.push({ path: fixedPath, size: 0, type: "REGULAR_FILE" });
    }
  }
  return results;
}

export {
  JS7z,
  disposeJS7z,
  fetchFileList,
  listViaExtract,
  readDirEntries,
  parse7zListing,
  decompressLz4Frames,
  writeLargeVFS,
};
