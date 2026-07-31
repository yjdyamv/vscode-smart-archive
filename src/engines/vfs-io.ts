/**
 * Virtual FS I/O primitives — Smart Archive VSCode Extension
 *
 * Low-level read/write operations between the local filesystem and the
 * JS7z Emscripten virtual filesystem. Extracted to break the circular
 * dependency between utils/fs and engines/js7z-helpers.
 *
 * @module engines/vfs-io
 */

import * as fs from "fs";
import * as path from "path";
import type { JS7zInstance } from "../types";
import { getBaseName } from "../utils/path";
import { t } from "../i18n";
import { checkFileSize } from "../utils/security";
import { logger } from "../utils/logger-core";
import { VFS_CHUNK } from "../constants";

const MAX_BUFFER = 2 * 1024 * 1024 * 1024 - 1;
const CHUNK = VFS_CHUNK;

function matchPartNum(name: string, pattern: RegExp): string {
  const m = name.match(pattern);
  return m ? m[1] : "0";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function copyToVFS(js7z: JS7zInstance, filePath: string, vfsPath: string): void {
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_BUFFER) {
    const data = fs.readFileSync(filePath);
    js7z.FS.writeFile(vfsPath, data);
    return;
  }

  // Stream in chunks via VFS open/write/close
  const rfd = fs.openSync(filePath, "r");
  try {
    js7z.FS.createDataFile("/", vfsPath.replace(/^\//, ""), new Uint8Array(0), true, true, 0o777);
    const vfsStream = js7z.FS.open(vfsPath, "w");
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      while (true) {
        const n = fs.readSync(rfd, buf, 0, buf.length, pos);
        if (n === 0) break;
        js7z.FS.write(vfsStream, new Uint8Array(buf.slice(0, n)), 0, n, pos);
        pos += n;
      }
    } finally {
      js7z.FS.close(vfsStream);
    }
  } finally {
    fs.closeSync(rfd);
  }
}

interface SplitVolumePattern {
  /** Regex that matches filenames belonging to this split set */
  pattern: RegExp;
  /** Function to build a VFS target path for a given part */
  targetForPart: (vfsPath: string | undefined, partName: string, partNum: string) => string;
  /** Optional: path to an additional "base" file to copy first (e.g. .rar) */
  extraBaseFile?: (dir: string, base: string) => string | undefined;
}

function streamSplitVolumes(
  js7z: JS7zInstance,
  dir: string,
  pattern: SplitVolumePattern,
  vfsPath?: string,
): string | undefined {
  const parts = fs
    .readdirSync(dir)
    .filter((f) => pattern.pattern.test(f))
    .sort(
      (a, b) =>
        parseInt(matchPartNum(a, pattern.pattern), 10) -
        parseInt(matchPartNum(b, pattern.pattern), 10),
    );

  if (parts.length === 0) return undefined;

  // Copy the extra base file first (e.g. .rar for RAR .rNN split volumes).
  // Must be done before the parts so 7z finds it when opening the first volume.
  if (pattern.extraBaseFile) {
    const firstPart = parts[0];
    // Strip known split-volume suffixes to get the base name for the callback.
    const baseName = firstPart.replace(/\.r\d{2}$/i, "").replace(/\.part\d+\.rar$/i, "");
    const basePath = pattern.extraBaseFile(dir, baseName);
    if (basePath) {
      // Place the base file in VFS alongside the split parts with the
      // matching naming convention (e.g. archive.rar next to archive.r00).
      const baseTarget = vfsPath
        ? vfsPath.replace(/\.r\d{2}$/i, ".rar").replace(/\.part\d+\.rar$/i, ".rar")
        : `/${path.basename(basePath)}`;
      copyToVFS(js7z, basePath, baseTarget);
    }
  }

  for (const partName of parts) {
    const partPath = path.join(dir, partName);
    const partNum = matchPartNum(partName, pattern.pattern);
    const target = pattern.targetForPart(vfsPath, partName, partNum);
    copyToVFS(js7z, partPath, target);
  }

  const firstNum = matchPartNum(parts[0], pattern.pattern);
  return pattern.targetForPart(vfsPath, parts[0], firstNum);
}

/**
 * Calculate the total size of all parts in a split volume archive.
 * Returns 0 when the file is not a split volume (caller uses fs.statSync).
 */
export function calcSplitVolumeTotalSize(filePath: string): number {
  const dir = path.dirname(filePath);

  // 7z/zip/wim split volumes
  const splitMatch = filePath.match(/^(.+\.(?:7z|zip|wim))\.(\d+)$/i);
  if (splitMatch) {
    const base = path.basename(splitMatch[1]);
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}\\.(\\d+)$`, "i");
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      if (re.test(f)) {
        total += fs.statSync(path.join(dir, f)).size;
      }
    }
    if (total > 0) return total;
  }

  // RAR .partN.rar volumes
  const rarPart = filePath.match(/^(.+)\.part(\d+)\.rar$/i);
  if (rarPart) {
    const base = path.basename(rarPart[1]);
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}\\.part(\\d+)\\.rar$`, "i");
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      if (re.test(f)) {
        total += fs.statSync(path.join(dir, f)).size;
      }
    }
    const rarBase = path.join(dir, `${path.basename(rarPart[1])}.rar`);
    if (fs.existsSync(rarBase)) total += fs.statSync(rarBase).size;
    if (total > 0) return total;
  }

  // RAR .rNN volumes
  const rarVol = filePath.match(/^(.+)\.(r(?:ar|\d{2}))$/i);
  if (rarVol && /^r\d{2}$/i.test(rarVol[2])) {
    const base = path.basename(rarVol[1]);
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}\\.r(\\d{2})$`, "i");
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      if (re.test(f)) {
        total += fs.statSync(path.join(dir, f)).size;
      }
    }
    const rarBase = path.join(dir, `${path.basename(rarVol[1])}.rar`);
    if (fs.existsSync(rarBase)) total += fs.statSync(rarBase).size;
    if (total > 0) return total;
  }

  return 0;
}

/**
 * Check that the archive input (including all split volume parts) does not
 * exceed the configured maximum file size. Call before starting decompression.
 */
export function checkArchiveInputSize(filePath: string): void {
  const totalSplit = calcSplitVolumeTotalSize(filePath);
  if (totalSplit > 0) {
    logger.info({ event: "vfsio.checkArchiveInputSize", totalBytes: totalSplit, filePath });
    checkFileSize(totalSplit);
  } else {
    checkFileSize(fs.statSync(filePath).size);
  }
}

export function streamToVFS(js7z: JS7zInstance, filePath: string, vfsPath?: string): string {
  const archiveName = getBaseName(filePath);
  const target = vfsPath ?? `/${archiveName}`;

  const dir = path.dirname(filePath);

  // 7z/zip/wim split volumes: archive.7z.001
  const splitMatch = filePath.match(/^(.+\.(?:7z|zip|wim))\.(\d+)$/i);
  if (splitMatch) {
    const base = splitMatch[1];
    const name = path.basename(base);
    const nameEscaped = escapeRegex(name);
    const partPattern = new RegExp(`^${nameEscaped}\\.(\\d+)$`, "i");

    const result = streamSplitVolumes(
      js7z,
      path.dirname(base),
      {
        pattern: partPattern,
        targetForPart: (vp, _partName, partNum) =>
          vp ? `${vp.replace(/\.\d+$/, "")}.${partNum}` : `/${name}.${partNum}`,
      },
      vfsPath,
    );

    if (!result) throw new Error(t("decompress.noSplitParts", path.basename(filePath)));
    return result;
  }

  // RAR split volumes: basename.part1.rar
  const rarPartMatch = filePath.match(/^(.+)\.part(\d+)\.rar$/i);
  if (rarPartMatch) {
    const base = rarPartMatch[1];
    const fn = path.basename(base);
    const fnEscaped = escapeRegex(fn);
    const partPattern = new RegExp(`^${fnEscaped}\\.part(\\d+)\\.rar$`, "i");

    const result = streamSplitVolumes(
      js7z,
      dir,
      {
        pattern: partPattern,
        targetForPart: (vp, _partName, partNum) =>
          vp ? `${vp.replace(/\.part\d+/, `.part${partNum}`)}` : `/${fn}.part${partNum}.rar`,
        extraBaseFile: (d, b) => {
          const rarBase = path.join(d, `${b}.rar`);
          return fs.existsSync(rarBase) ? rarBase : undefined;
        },
      },
      vfsPath,
    );

    if (result) return result;
  }

  // RAR split volumes: basename.r00, basename.r01, ...
  const rarVolMatch = filePath.match(/^(.+)\.(r(?:ar|\d{2}))$/i);
  if (rarVolMatch && /^r\d{2}$/i.test(rarVolMatch[2])) {
    const baseName = rarVolMatch[1];
    const fn = path.basename(baseName);
    const fnEscaped = escapeRegex(fn);
    const rnnPattern = new RegExp(`^${fnEscaped}\\.r(\\d{2})$`, "i");

    const result = streamSplitVolumes(
      js7z,
      dir,
      {
        pattern: rnnPattern,
        targetForPart: (vp, _partName, partNum) =>
          vp ? vp.replace(/\.r\d{2}$/, `.r${partNum}`) : `/${fn}.r${partNum}`,
        extraBaseFile: (d, b) => {
          const rarBase = path.join(d, `${b}.rar`);
          return fs.existsSync(rarBase) ? rarBase : undefined;
        },
      },
      vfsPath,
    );

    if (result) return result;
  }

  copyToVFS(js7z, filePath, target);
  return target;
}

export { MAX_BUFFER };
