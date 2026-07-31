/**
 * TAR writer — Smart Archive VSCode Extension
 *
 * Pure Node.js streaming TAR creator. Writes a TAR archive directly
 * to disk without loading files into memory, bypassing WASM limits.
 *
 * @module engines/tar-writer
 */

import * as fs from "fs";
import * as path from "path";
import { prepareExclusions, isPathExcluded } from "../utils/exclude";
import { CancelledError } from "../utils/cancellation";
import type { TokenLike } from "../utils/cancellation";

const BLOCK = 512;

export function writeLongLink(fd: number, fullName: string): void {
  const nameBytes = Buffer.from(fullName);
  // GNU tar long filename: type 'L' header with "././@LongLink" as name,
  // followed by the full path padded to BLOCK boundary.
  const header = tarHeader("././@LongLink", nameBytes.length, false);
  header[156] = 0x4c; // type 'L'
  // Recompute checksum after changing type
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i];
  }
  const chk = sum.toString(8).padStart(6, "0") + "\0 ";
  Buffer.from(chk).copy(header, 148);
  fs.writeSync(fd, header);
  fs.writeSync(fd, nameBytes);
  const pad = padSize(nameBytes.length) - nameBytes.length;
  if (pad > 0) fs.writeSync(fd, Buffer.alloc(pad));
}

function tarHeader(name: string, size: number, isDir: boolean): Buffer {
  const buf = Buffer.alloc(BLOCK);
  // Split into ustar prefix (directory, 155 bytes) + name (basename, 100 bytes).
  // Supported by WASM 7z; avoids GNU LongLink type 'L' which WASM 7z ignores.
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const lastSlash = name.lastIndexOf("/");
    if (lastSlash >= 0) {
      const dirPart = name.slice(0, lastSlash);
      const basePart = name.slice(lastSlash + 1);
      if (Buffer.byteLength(dirPart) <= 155 && Buffer.byteLength(basePart) <= 100) {
        prefix = dirPart;
        name = basePart;
      }
    }
  }
  Buffer.from(name.slice(0, 100)).copy(buf, 0);
  // mode (8) — octal string, space-padded right
  const mode = isDir ? "000755 " : "000644 ";
  Buffer.from(mode).copy(buf, 100);
  // uid/gid (8 each) — zero-padded
  Buffer.from("000000 ").copy(buf, 108);
  Buffer.from("000000 ").copy(buf, 116);
  // size (12) — octal string
  const sizeOctal = size.toString(8).padStart(11, "0") + " ";
  Buffer.from(sizeOctal).copy(buf, 124);
  // mtime (12) — octal
  const mtime =
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + " ";
  Buffer.from(mtime).copy(buf, 136);
  // chksum (8) — blanks for now, compute below
  Buffer.from("        ").copy(buf, 148);
  // typeflag (1)
  buf[156] = isDir ? 0x35 : 0x30; // '5' for dir, '0' for file
  // magic + version
  Buffer.from("ustar").copy(buf, 257);
  buf[263] = 0x30; // "00"
  buf[264] = 0x30;
  // uname/gname (32 each)
  Buffer.from("root").copy(buf, 265);
  Buffer.from("root").copy(buf, 297);
  // ustar prefix (155 bytes at offset 345)
  Buffer.from(prefix).copy(buf, 345);
  // Compute checksum — sum of all bytes, with checksum field treated as spaces
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 32 : buf[i];
  }
  const chk = sum.toString(8).padStart(6, "0") + "\0 ";
  Buffer.from(chk).copy(buf, 148);
  return buf;
}

function padSize(n: number): number {
  return n % BLOCK === 0 ? n : n + BLOCK - (n % BLOCK);
}

function collectPaths(
  basePath: string,
  exclusions: ReturnType<typeof prepareExclusions>,
  token?: TokenLike,
): string[] {
  const result: string[] = [];
  const stack = [basePath];
  while (stack.length > 0) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      const rel = path.relative(basePath, full).replace(/\\/g, "/");
      if (isPathExcluded(rel, exclusions)) continue;
      if (e.isDirectory()) {
        result.push(full);
        stack.push(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        result.push(full);
      }
    }
  }
  return result;
}

function needsLongLink(name: string): boolean {
  // tarHeader handles names up to 255 bytes via ustar prefix (155) + name (100).
  // Only need GNU LongLink when the basename alone exceeds 100 bytes.
  if (Buffer.byteLength(name) <= 100) return false;
  const lastSlash = name.lastIndexOf("/");
  if (lastSlash < 0) return Buffer.byteLength(name) > 100;
  return Buffer.byteLength(name.slice(lastSlash + 1)) > 100;
}

export async function createTarFile(
  outputPath: string,
  localPaths: readonly string[],
  token?: TokenLike,
  excludePatterns: string[] = [],
): Promise<void> {
  if (localPaths.length === 0) {
    throw new Error("No files to add to TAR archive");
  }

  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const fd = fs.openSync(outputPath, "w");

  const exclusions = prepareExclusions(excludePatterns);

  try {
    const rootDir = path.dirname(localPaths[0]);

    for (const loc of localPaths) {
      if (token?.isCancellationRequested) throw new CancelledError();

      const stat = fs.statSync(loc);
      const rel = path.relative(rootDir, loc).replace(/\\/g, "/");

      if (stat.isDirectory()) {
        const dirName = rel + "/";
        // Write directory entry
        if (needsLongLink(dirName)) writeLongLink(fd, dirName);
        fs.writeSync(fd, tarHeader(dirName, 0, true));
        const all = collectPaths(loc, exclusions, token);
        for (const full of all) {
          if (token?.isCancellationRequested) throw new CancelledError();
          const fstat = fs.lstatSync(full);
          const frel = path.relative(rootDir, full).replace(/\\/g, "/");
          if (fstat.isSymbolicLink()) {
            // Skip symlinks — WASM 7z does not support GNU tar
            // type '2' (symlink) or type 'K' (long link target).
            continue;
          } else if (fstat.isDirectory()) {
            const dname = frel + "/";
            if (needsLongLink(dname)) writeLongLink(fd, dname);
            fs.writeSync(fd, tarHeader(dname, 0, true));
          } else if (stat.isSymbolicLink()) {
            // Skip symlinks at top level
            continue;
          } else {
            if (needsLongLink(frel)) writeLongLink(fd, frel);
            fs.writeSync(fd, tarHeader(frel, fstat.size, false));
            const rfd = fs.openSync(full, "r");
            try {
              const buf = Buffer.alloc(1024 * 1024);
              let bytesRead: number;
              let written = 0;
              while ((bytesRead = fs.readSync(rfd, buf, 0, buf.length, null)) > 0) {
                fs.writeSync(fd, buf, 0, bytesRead);
                written += bytesRead;
              }
              const pad = padSize(written) - written;
              if (pad > 0) fs.writeSync(fd, Buffer.alloc(pad));
            } finally {
              fs.closeSync(rfd);
            }
          }
        }
      } else {
        if (needsLongLink(rel)) writeLongLink(fd, rel);
        fs.writeSync(fd, tarHeader(rel, stat.size, false));
        const rfd = fs.openSync(loc, "r");
        try {
          const buf = Buffer.alloc(1024 * 1024);
          let bytesRead: number;
          let written = 0;
          while ((bytesRead = fs.readSync(rfd, buf, 0, buf.length, null)) > 0) {
            fs.writeSync(fd, buf, 0, bytesRead);
            written += bytesRead;
          }
          const pad = padSize(written) - written;
          if (pad > 0) fs.writeSync(fd, Buffer.alloc(pad));
        } finally {
          fs.closeSync(rfd);
        }
      }
    }
    // End-of-archive: two zero blocks
    fs.writeSync(fd, Buffer.alloc(BLOCK * 2));
  } finally {
    fs.closeSync(fd);
  }
}
