import fs from "fs";
import path from "path";

/**
 * Extract the first file ending with ".node" from a gzipped npm tarball (tgz).
 * Returns the raw .node data, or null if not found.
 */
function extractNodeFromTgz(tgzBuf) {
  return extractFileFromTgz(tgzBuf, (name) => name.endsWith(".node"));
}

/**
 * Extract a file from a gzipped npm tarball (tgz) by exact suffix/name
 * predicate. Returns the raw file data, or null if not found.
 */
function extractFileFromTgz(tgzBuf, match) {
  const BLOCK = 512;
  let pos = 0;
  const buf = tgzBuf;
  while (pos + BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;
    let nameEnd = header.indexOf(0, 0);
    if (nameEnd < 0 || nameEnd > 100) nameEnd = 100;
    const name = header.subarray(0, nameEnd).toString("utf8");
    const typeFlag = String.fromCharCode(header[156]);
    const isDir = typeFlag === "5";
    const isLongName = typeFlag === "L" || typeFlag === "K";
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    pos += BLOCK;
    if (isLongName) {
      pos += Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    const dataEnd = pos + Math.ceil(size / BLOCK) * BLOCK;
    const wanted = typeof match === "function" ? match(name) : match;
    if (!isDir && wanted) return buf.subarray(pos, pos + size);
    pos = dataEnd;
  }
  return null;
}

/** Recursively find a file by basename under a directory. */
function findFileInTree(root, basename) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === basename) return full;
    }
  }
  return null;
}

export { extractNodeFromTgz, extractFileFromTgz, findFileInTree };
