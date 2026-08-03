/**
 * 7z listing parser — Smart Archive VSCode Extension
 *
 * Parses stdout from `7z l -slt` into a flat entry list.
 * Shared between js7z-list.ts and fileListing.ts to avoid
 * duplicate parsing logic.
 *
 * @module utils/parse7z
 */

import { fixArchiveEncoding, getBaseName } from "./path";
import { getFullExt, getFormatByExt, getSplitVolumeBase } from "../constants";

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

  const MAX_ENTRIES = 100_000;

  for (const line of stdout.split("\n")) {
    if (results.length >= MAX_ENTRIES) break;
    const eq = line.indexOf(" = ");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 3).trim();
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
  const filtered = results.filter((r) => {
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

  // Single-file stream formats (gz/xz/bz2): `7z l -slt` emits no `Path`
  // entry for the inner file, so synthesize the single built-in entry
  // (the archive name minus the stream extension, e.g. data.xz → data).
  if (filtered.length === 0) {
    const ext = getFullExt(archiveName);
    if (getFormatByExt(ext)?.category === "stream") {
      const base = getBaseName(archiveName);
      const inner = ext ? base.slice(0, -ext.length) || base : base;
      const sizeMatch = stdout.match(/^\s*Size = (\d+)\s*$/m);
      filtered.push({
        path: fixArchiveEncoding(inner),
        size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
        type: "REGULAR_FILE",
      });
    }
  }
  return filtered;
}
