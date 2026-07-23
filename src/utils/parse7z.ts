/**
 * 7z listing parser — Smart Archive VSCode Extension
 *
 * Parses stdout from `7z l -slt` into a flat entry list.
 * Shared between js7z-list.ts and fileListing.ts to avoid
 * duplicate parsing logic.
 *
 * @module utils/parse7z
 */

import { fixArchiveEncoding } from "./path";
import { getSplitVolumeBase } from "../constants";

export interface ArchiveEntry {
  path: string;
  size: number;
  type: string;
}

export function parse7zListing(
  stdout: string,
  archiveName: string,
  archivePath?: string,
): ArchiveEntry[] {
  const results: ArchiveEntry[] = [];
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

  // Second pass: for entries without Attributes, infer directories
  // by checking whether any other entry's path starts with this one + "/".
  // TAR format listings omit the Attributes field entirely.
  const pathSet = new Set(results.map((r) => r.path));
  for (const r of results) {
    if (r.type === "DIRECTORY") continue;
    const prefix = r.path + "/";
    for (const p of pathSet) {
      if (p.startsWith(prefix)) {
        r.type = "DIRECTORY";
        break;
      }
    }
  }

  const volBase = getSplitVolumeBase(archiveName);
  return results.filter((r) => {
    const p = r.path;
    if (p === `/${archiveName}` || p === archiveName) return false;
    if (volBase && (p === `/${volBase}` || p === volBase)) return false;
    if (archivePath) {
      if (p === archivePath) return false;
      if (p === archivePath.replace(/\\/g, "/")) return false;
      if (p.toLowerCase() === archivePath.toLowerCase()) return false;
    }
    return true;
  });
}
