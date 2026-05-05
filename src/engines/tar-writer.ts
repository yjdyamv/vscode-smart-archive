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
import * as vscode from "vscode";
import { prepareExclusions, isPathExcluded, isTargetExcluded } from "../utils/exclude";

const BLOCK = 512;

function tarHeader(name: string, size: number, isDir: boolean): Buffer {
  const buf = Buffer.alloc(BLOCK);
  // name (100) — zero-padded
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
  token?: vscode.CancellationToken,
): string[] {
  const result: string[] = [];
  const stack = [basePath];
  while (stack.length > 0) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      const rel = path.relative(basePath, full).replace(/\\/g, "/");
      if (isPathExcluded(rel, exclusions)) continue;
      if (e.isDirectory()) {
        result.push(full);
        stack.push(full);
      } else if (e.isFile()) {
        result.push(full);
      }
    }
  }
  return result;
}

export async function createTarFile(
  outputPath: string,
  localPaths: readonly string[],
  token?: vscode.CancellationToken,
  excludePatterns: string[] = [],
): Promise<void> {
  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const fd = fs.openSync(outputPath, "w");

  const exclusions = prepareExclusions(excludePatterns);

  try {
    const rootDir = path.dirname(localPaths[0]);

    for (const loc of localPaths) {
      if (token?.isCancellationRequested) throw new vscode.CancellationError();

      if (isTargetExcluded(loc, exclusions)) continue;

      const stat = fs.statSync(loc);
      const rel = path.relative(rootDir, loc).replace(/\\/g, "/");

      if (stat.isDirectory()) {
        // Write directory entry
        fs.writeSync(fd, tarHeader(rel + "/", 0, true));
        const all = collectPaths(loc, exclusions, token);
        for (const full of all) {
          if (token?.isCancellationRequested) throw new vscode.CancellationError();
          const fstat = fs.statSync(full);
          const frel = path.relative(rootDir, full).replace(/\\/g, "/");
          if (fstat.isDirectory()) {
            fs.writeSync(fd, tarHeader(frel + "/", 0, true));
          } else {
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
              // Pad to 512-byte boundary
              const pad = padSize(written) - written;
              if (pad > 0) fs.writeSync(fd, Buffer.alloc(pad));
            } finally {
              fs.closeSync(rfd);
            }
          }
        }
      } else {
        // Write file entry
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
