import fs from "fs";
import path from "path";

/**
 * Atomically replace a file (temp + rename). A previously staged binary may
 * still be running/loaded (ETXTBSY on POSIX if written in place); renaming
 * over it lets the old inode finish while the new file takes over the path.
 */
function writeFileAtomic(destPath, data) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(destPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, destPath);
  } catch (err) {
    if (process.platform !== "win32") throw err;
    // Windows cannot rename over an existing file — remove then swap.
    fs.rmSync(destPath, { force: true });
    fs.renameSync(tmp, destPath);
  }
}

/** Copy a source file into place atomically (see writeFileAtomic). */
function copyFileAtomic(srcPath, destPath) {
  writeFileAtomic(destPath, fs.readFileSync(srcPath));
}

export { writeFileAtomic, copyFileAtomic };
