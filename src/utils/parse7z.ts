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

  const volBase = getSplitVolumeBase(archiveName);
  return results.filter((r) => {
    if (r.path === `/${archiveName}` || r.path === archiveName) return false;
    if (volBase && (r.path === `/${volBase}` || r.path === volBase)) return false;
    return true;
  });
}
