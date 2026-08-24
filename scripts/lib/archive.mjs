import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { x as tarExtract } from "tar";

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

/**
 * Pure-Node PATH lookup — replaces spawning `command -v` (a shell builtin,
 * so execFileSync always threw ENOENT and was silently swallowed) and
 * `where` (Windows-only). Checks each PATH dir for an executable match.
 */
function findOnPath(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* not here — keep looking */
      }
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
    const found = findOnPath("7zz") ?? findOnPath("7z");
    if (found) return found;
    // Fall back to just-staged darwin binary
    for (const a of ["arm64", "x64"]) {
      const p = path.join(stagedRoot, "darwin", a, "7zz");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  // Windows: check common install paths + PATH, then the staged binary
  // matching THIS host's arch (a staged exe of another arch cannot run —
  // spawning it fails with UNKNOWN instead of a clean "not found").
  if (platform === "win32") {
    for (const p of [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "7-Zip", "7z.exe"),
      "C:\\Program Files\\7-Zip\\7z.exe",
      "C:\\Program Files (x86)\\7-Zip\\7z.exe",
      // 7-Zip ZS (mcmilk fork) installs here by default.
      "C:\\Program Files\\7-Zip-Zstandard\\7z.exe",
      "C:\\Program Files\\7-Zip-Zstandard\\7zz.exe",
    ]) {
      if (fs.existsSync(p)) return p;
    }
    const found = findOnPath("7z.exe") ?? findOnPath("7zz.exe");
    if (found) return found;
    // Fall back to a just-staged win32 binary of the current arch only.
    for (const bin of ["7zz.exe", "7z.exe"]) {
      const p = path.join(stagedRoot, "win32", process.arch, bin);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  return null;
}

/**
 * Extract an archive into destDir. kind "tgz" uses the npm `tar` package
 * (NOT the system tar — Git's MSYS tar on Windows misparses `C:\...` paths
 * as `host:path` remote syntax and fails); kind "zip" uses a host 7z/7zz
 * binary (staged binaries included) to unpack Windows SFX.
 * On Windows hosts without any 7-Zip, the built-in PowerShell Expand-Archive
 * is used — the win32 7zz.exe we stage lives inside the very zip we need to
 * unpack, so requiring a system 7-Zip there would break fresh staging.
 */
function extractArchive(
  kind,
  archivePath,
  destDir,
  { platform = process.platform, stagedRoot } = {},
) {
  fs.mkdirSync(destDir, { recursive: true });
  if (kind === "tgz") {
    // sync mode keeps extractArchive synchronous; file modes are preserved so
    // the staged linux/darwin 7zz binaries stay executable.
    tarExtract({ file: archivePath, cwd: destDir, gzip: true, sync: true });
    return;
  }
  if (kind !== "zip") throw new Error(`unsupported archive kind: ${kind}`);
  const sz = findHostSevenZip(platform, stagedRoot);
  if (!sz) {
    if (platform === "win32") {
      // No system 7-Zip and no staged win32 binary yet (chicken-and-egg:
      // the staged 7zz.exe is inside the zip being unpacked). PowerShell's
      // Expand-Archive handles the GitHub-release zips reliably (the CI
      // workflow already relies on it).
      const ps = (p) => String(p).replace(/'/g, "''");
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -Force -LiteralPath '${ps(archivePath)}' -DestinationPath '${ps(destDir)}'`,
        ],
        { stdio: "inherit" },
      );
      return;
    }
    throw new Error(
      `Cannot extract Windows SFX on ${platform}-${process.arch}: no 7z/7zz found. ` +
        "On Linux/macOS install p7zip; on Windows install 7-Zip from https://www.7-zip.org/.",
    );
  }
  if (platform !== "win32") fs.chmodSync(sz, 0o755);
  execFileSync(sz, ["x", "-y", `-o${destDir}`, archivePath], { stdio: "inherit" });
}

export { extractNodeFromTgz, extractFileFromTgz, findFileInTree, findHostSevenZip, extractArchive };
