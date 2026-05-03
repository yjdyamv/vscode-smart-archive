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
import type { JS7zFactory, JS7zInstance } from "../types";
import { listFiles } from "../engines/js7z-engine";
import { getFullExt, isWrappedFormat, isEncryptableExt } from "../constants";
import { logger } from "../utils/logger";
import { tryCleanup } from "../engines/js7z-helpers";
import { fixArchiveEncoding } from "../utils/path";
import { validatePassword } from "../utils/security";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z: JS7zFactory = require("js7z-tools");

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
    logger.warn(
      { event: "fetchFileList.listFiles.failed", err, filePath },
      "js7z listing failed",
    );
  }
  if (!password && isEncryptableExt(ext)) return [];
  return [];
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
    if (topEntries.length === 1 && topEntries[0].endsWith(".tar")) {
      const innerTar = topEntries[0];
      const innerData = js7z.FS.readFile(`/_ls/${innerTar}`, { encoding: "binary" });
      // List inner tar via 7z l -slt (metadata-only, no extraction)
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
      logger.warn({ event: "readDirEntries.stat.failed" }, "Failed to stat virtual FS entry");
      results.push({ path: childPath, size: 0, type: "REGULAR_FILE" });
    }
  }
  return results;
}

/**
 * Parse stdout from `7z l -slt` into a flat entry list.
 * Shared between js7z-list.ts and the fast wrapped-format listing path.
 */
function parse7zListing(
  stdout: string,
  archiveName: string,
): { path: string; size: number; type: string }[] {
  const results: { path: string; size: number; type: string }[] = [];
  let curPath = "";
  let curSize = 0;
  let curAttr = "";

  const flush = () => {
    if (curPath) {
      results.push({
        path: fixArchiveEncoding(curPath),
        size: curSize,
        type: curAttr.includes("D") ? "DIRECTORY" : "REGULAR_FILE",
      });
    }
    curPath = "";
    curSize = 0;
    curAttr = "";
  };

  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\w[\w ]*?)\s*=\s*(.*)/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === "Path") {
      flush();
      curPath = val;
    } else if (key === "Size" && !curSize) {
      curSize = parseInt(val, 10) || 0;
    } else if (key === "Attributes") {
      curAttr = val;
    }
  }
  flush();

  // Filter out the archive's own self-reference entry
  return results.filter((r) => r.path !== `/${archiveName}` && r.path !== archiveName);
}

export {
  JS7z,
  tryCleanup as tryCleanupJS7z,
  fetchFileList,
  listViaExtract,
  readDirEntries,
  parse7zListing,
};
