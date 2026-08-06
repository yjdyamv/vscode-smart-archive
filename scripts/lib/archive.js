const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Extract the first file ending with ".node" from a gzipped npm tarball (tgz).
 * Returns the raw .node data, or null if not found.
 */
function extractNodeFromTgz(tgzBuf) {
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
    if (!isDir && name.endsWith(".node")) return buf.subarray(pos, pos + size);
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

/** Find a 7z/7zz binary usable on the current host to unpack Windows SFX. */
function findHostSevenZip(platform, stagedRoot) {
  // Linux: use the just-staged linux-x64 7zz
  if (platform === "linux") {
    const p = path.join(stagedRoot, "linux", "x64", "7zz");
    return fs.existsSync(p) ? p : null;
  }
  // macOS: look for system 7z (brew, etc.), then staged binary
  if (platform === "darwin") {
    for (const p of [
      "/opt/homebrew/bin/7zz",
      "/opt/homebrew/bin/7z",
      "/usr/local/bin/7zz",
      "/usr/local/bin/7z",
    ]) {
      if (fs.existsSync(p)) return p;
    }
    try {
      execFileSync("command", ["-v", "7zz"], { stdio: "pipe" });
      return "7zz";
    } catch {
      /* not on PATH */
    }
    try {
      execFileSync("command", ["-v", "7z"], { stdio: "pipe" });
      return "7z";
    } catch {
      /* not on PATH */
    }
    // Fall back to just-staged darwin binary
    for (const a of ["arm64", "x64"]) {
      const p = path.join(stagedRoot, "darwin", a, "7zz");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  // Windows: check common install paths + PATH, then staged binary
  if (platform === "win32") {
    for (const p of [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "7-Zip", "7z.exe"),
      "C:\\Program Files\\7-Zip\\7z.exe",
      "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    ]) {
      if (fs.existsSync(p)) return p;
    }
    try {
      execFileSync("where", ["7z.exe"], { stdio: "pipe" });
      return "7z.exe";
    } catch {
      /* not on PATH */
    }
    try {
      execFileSync("where", ["7zz.exe"], { stdio: "pipe" });
      return "7zz.exe";
    } catch {
      /* not on PATH */
    }
    // Fall back to just-staged win32 binary (7zz.exe; 7z.exe covers stale
    // vendor dirs from older staging runs)
    for (const a of ["x64", "arm64", "ia32"]) {
      for (const bin of ["7zz.exe", "7z.exe"]) {
        const p = path.join(stagedRoot, "win32", a, bin);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }
  return null;
}

/**
 * Extract an archive into destDir. kind "tgz" uses the system tar; kind "zip"
 * uses a host 7z/7zz binary (staged binaries included) to unpack Windows SFX.
 */
function extractArchive(
  kind,
  archivePath,
  destDir,
  { platform = process.platform, stagedRoot } = {},
) {
  fs.mkdirSync(destDir, { recursive: true });
  if (kind === "tgz") {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    return;
  }
  if (kind !== "zip") throw new Error(`unsupported archive kind: ${kind}`);
  const sz = findHostSevenZip(platform, stagedRoot);
  if (!sz) {
    throw new Error(
      `Cannot extract Windows SFX on ${platform}-${process.arch}: no 7z/7zz found. ` +
        "On Linux/macOS install p7zip; on Windows install 7-Zip from https://www.7-zip.org/.",
    );
  }
  if (platform !== "win32") fs.chmodSync(sz, 0o755);
  execFileSync(sz, ["x", "-y", `-o${destDir}`, archivePath], { stdio: "inherit" });
}

module.exports = {
  extractNodeFromTgz,
  findFileInTree,
  findHostSevenZip,
  extractArchive,
};
