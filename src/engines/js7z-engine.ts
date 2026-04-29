/**
 * js7z-tools engine wrapper — 7z VSCode Extension
 *
 * Wraps js7z-tools (7-Zip compiled to WebAssembly via Emscripten) behind a
 * clean async interface. Handles virtual FS setup, local ↔ virtual FS copy,
 * command execution, and exit code interpretation.
 *
 * Workflow for compression:
 *   1. Create JS7z instance
 *   2. mkdir /in, /out in the virtual FS
 *   3. Copy local files → /in (recursively for directories)
 *   4. callMain(['a', '/out/archive.7z', '/in/*'])
 *   5. Read /out/archive.7z → write to local file system
 *
 * Workflow for decompression:
 *   1. Create JS7z instance
 *   2. Read archive from local FS → /archive.xxx in virtual FS
 *   3. callMain(['x', '/archive.xxx', '-o/out'])
 *   4. Recursively copy /out → local output directory
 *
 * @see https://github.com/GMH-Code/JS7z
 * @module engines/js7z-engine
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type {
  JS7zInstance,
  JS7zFactory,
  CompressOptions,
  DecompressOptions,
  FormatInfo,
} from "../types";
import { copyDirToFS, copyDirFromFS } from "../utils/fs";
import { joinFSPath, getBaseName, fixArchiveEncoding } from "../utils/path";
import { t, formatDuration } from "../i18n";
import { isWrappedFormat, getWrapExtension } from "../constants";
import { zstdCompress } from "./zstd-codec";

// js7z-tools is a CommonJS module — use require
// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z: JS7zFactory = require("js7z-tools");

function tryCleanup(instance: JS7zInstance): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst = instance as any;
    if (typeof inst.destroy === "function") inst.destroy();
    else if (typeof inst._cleanup === "function") inst._cleanup();
  } catch {
    /* best-effort cleanup */
  }
}

/** Virtual FS mount point for input files */
const INPUT_DIR = "/in";

/** Virtual FS mount point for output archives */
const OUTPUT_DIR = "/out";

/**
 * Copy local files/directories into the JS7z virtual FS.
 *
 * @returns Array of virtual FS paths for each copied item
 */
function copyInputsToFS(
  js7z: JS7zInstance,
  localPaths: readonly string[],
  token?: vscode.CancellationToken,
): string[] {
  const fsPaths: string[] = [];
  for (const localPath of localPaths) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    const name = getBaseName(localPath);
    const fsTarget = joinFSPath(INPUT_DIR, name);
    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      js7z.FS.mkdir(fsTarget);
      copyDirToFS(js7z, localPath, fsTarget, token);
    } else {
      const data = fs.readFileSync(localPath);
      js7z.FS.writeFile(fsTarget, new Uint8Array(data));
    }
    fsPaths.push(fsTarget);
  }
  return fsPaths;
}

/**
 * Build the argument array for a 7z 'a' (add) command.
 *
 * Stream formats (gz/bz2/xz) only support single files.
 * For folders or multiple files, the caller should use tar.gz/tar.bz2/tar.xz
 * which we handle as a two-step tar + compress pipeline.
 *
 * @param outputFile - Virtual FS path for the output archive
 * @param inputPaths - Virtual FS paths to add
 * @param format - Target archive format
 * @param password - Encryption password (empty = no encryption)
 */
function buildCompressArgs(
  outputFile: string,
  inputPaths: string[],
  format: FormatInfo,
  password: string,
  level: number,
): string[] {
  const args: string[] = ["a", outputFile];

  if (password) {
    args.push(`-p${password}`);
    if (format.label === "7z") {
      args.push("-mhe=on");
    }
  }

  args.push(`-mx${level}`);
  args.push(...inputPaths);
  return args;
}

/**
 * Compress files/folders using js7z-tools.
 *
 * @param options - Compression parameters
 * @param progress - VSCode progress reporter for status updates
 */
export async function compressWith7z(
  options: CompressOptions,
  progress: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  const startTime = Date.now();
  progress.report({ message: t("compress.initEngine") });

  const js7z = await JS7z();

  // Prepare virtual FS
  js7z.FS.mkdir(INPUT_DIR);
  js7z.FS.mkdir(OUTPUT_DIR);

  // Copy input files into the virtual FS
  progress.report({ message: t("compress.readingFiles") });
  const localPaths = options.targets.map((target) => target.fsPath);
  const fsInputPaths = copyInputsToFS(js7z, localPaths, token);
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
  progress.report({ message: t("compress.addedItems", String(localPaths.length)) });

  const archiveName = getBaseName(options.outputPath);
  const archiveFsPath = joinFSPath(OUTPUT_DIR, archiveName);

  // Two-step: tar + compress for tar.gz / tar.bz2 / tar.xz
  if (isWrappedFormat("." + options.format.label)) {
    const wrapExt = getWrapExtension("." + options.format.label);
    const tarFsPath = joinFSPath(OUTPUT_DIR, "_tmp.tar");

    // Step 1: create tar in first js7z instance
    progress.report({ message: t("compress.creatingTar") });
    await run7z(js7z, ["a", tarFsPath, ...fsInputPaths], progress);

    // Read the tar out of the first instance's virtual FS
    const tarData = js7z.FS.readFile(tarFsPath, { encoding: "binary" });

    if (token?.isCancellationRequested) throw new vscode.CancellationError();

    let compressedData: Uint8Array;
    if (wrapExt === "zst") {
      // Use zstd-wasm for the compression layer (7z WASM lacks zstd codec)
      progress.report({ message: t("compress.compressingTar", wrapExt) });
      compressedData = await zstdCompress(new Uint8Array(tarData), options.level);
    } else {
      // Step 2: compress tar in a FRESH js7z instance (for gz/bz2/xz)
      progress.report({ message: t("compress.compressingTar", wrapExt) });
      const js7z2 = await JS7z();
      js7z2.FS.writeFile("/_tmp.tar", new Uint8Array(tarData));
      await run7z(js7z2, ["a", archiveFsPath, "/_tmp.tar"], progress);
      compressedData = new Uint8Array(js7z2.FS.readFile(archiveFsPath, { encoding: "binary" }));
      tryCleanup(js7z2);
    }

    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    fs.writeFileSync(options.outputPath, Buffer.from(compressedData));
    const elapsed = formatDuration(Date.now() - startTime);
    vscode.window.showInformationMessage(
      t("compress.done") + options.outputPath + t("time.elapsed", elapsed),
    );
    tryCleanup(js7z);
    return;
  }

  // Non-wrapped formats: single-step compression
  const args = buildCompressArgs(
    archiveFsPath,
    fsInputPaths,
    options.format,
    options.password,
    options.level,
  );
  await run7z(js7z, args, progress);

  // Read result from virtual FS and write to local disk
  const data = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
  fs.writeFileSync(options.outputPath, Buffer.from(data));
  const elapsed = formatDuration(Date.now() - startTime);
  vscode.window.showInformationMessage(
    t("compress.done") + options.outputPath + t("time.elapsed", elapsed),
  );
  tryCleanup(js7z);
}

/** Run a 7z command and wait for completion. Reports progress from stdout. */
function run7z(
  js7z: JS7zInstance,
  args: string[],
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  onStdout?: (text: string) => void,
): Promise<void> {
  let stderr = "";
  let lastPct = -1;
  js7z.print = (text: string) => {
    if (onStdout) onStdout(text);
    // 7-Zip outputs percentage lines like " 21%" or "  0M Scan /"
    const m = text.match(/(\d{1,3})%/);
    if (m && progress) {
      const pct = parseInt(m[1], 10);
      if (pct !== lastPct) {
        lastPct = pct;
        progress.report({ message: `${pct}%`, increment: pct });
      }
    }
  };
  js7z.printErr = (text: string) => {
    stderr += text + "\n";
  };

  return new Promise<void>((resolve, reject) => {
    js7z.onExit = (exitCode: number) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(t("compress.exitError", String(exitCode)) + "\n" + stderr));
      }
    };
    js7z.callMain(args);
  });
}

/**
 * Decompress an archive using js7z-tools.
 *
 * @param options - Decompression parameters
 * @param progress - VSCode progress reporter
 */
export async function decompressWith7z(
  options: DecompressOptions,
  progress: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  const startTime = Date.now();
  progress.report({ message: t("decompress.initEngine") });

  const js7z = await JS7z();

  // Read archive into virtual FS
  const data = fs.readFileSync(options.inputPath);
  const archiveName = getBaseName(options.inputPath);
  js7z.FS.writeFile(`/${archiveName}`, new Uint8Array(data));
  js7z.FS.mkdir(OUTPUT_DIR);

  // Build extraction args (password inserted before archive path)
  const extractArgs: string[] = ["x", `/${archiveName}`, `-o${OUTPUT_DIR}`];
  if (options.password) {
    extractArgs.splice(1, 0, `-p${options.password}`);
  }

  progress.report({ message: t("decompress.inProgress") });

  await run7z(js7z, extractArgs, progress);
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
  copyDirFromFS(js7z, OUTPUT_DIR, options.outputDir, token);

  // Auto-extract inner .tar left by tar.gz/tar.bz2/tar.xz decompression.
  // These layered archives decompress to a single .tar which needs unwrapping.
  await unwrapInnerTar(options.outputDir, progress);

  const elapsed = formatDuration(Date.now() - startTime);
  vscode.window.showInformationMessage(
    t("decompress.done") + options.outputDir + t("time.elapsed", elapsed),
  );
  tryCleanup(js7z);
}

/**
 * If the output directory contains only a single .tar file (leftover from
 * tar.gz/tar.bz2/tar.xz decompression), extract it and remove the tar.
 */
async function unwrapInnerTar(
  outputDir: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  const entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");
  const tarFiles = entries.filter((e) => e.endsWith(".tar"));

  // Only auto-extract if there's exactly one .tar and no other files/dirs
  if (tarFiles.length !== 1 || entries.length !== 1) return;

  const tarPath = path.join(outputDir, tarFiles[0]);
  progress.report({ message: t("decompress.unwrapTar") });

  const tarData = fs.readFileSync(tarPath);
  const js7z = await JS7z();
  js7z.FS.writeFile("/_inner.tar", new Uint8Array(tarData));
  js7z.FS.mkdir("/_inner_out");

  await run7z(js7z, ["x", "/_inner.tar", "-o/_inner_out"], progress);
  copyDirFromFS(js7z, "/_inner_out", outputDir);

  // Remove the intermediate tar
  fs.unlinkSync(tarPath);
  tryCleanup(js7z);
}

/**
 * List files in an archive using `7z l -slt`.
 *
 * Returns parsed entries with reliable UTF-8 filenames (7-Zip
 * internally stores UTF-16LE and outputs correctly decoded UTF-8).
 * This avoids libarchive-wasm encoding issues with CJK paths.
 *
 * @param filePath - Path to the archive file
 * @returns Array of { path, size, type } entries
 */
export async function listFiles(
  filePath: string,
): Promise<{ path: string; size: number; type: string }[]> {
  const data = fs.readFileSync(filePath);
  let stdout = "";
  let stderr = "";

  // Pass print/printErr via constructor so out/err are set before
  // Emscripten initialisation — this bypasses the terminal layer
  // that would otherwise replace non-ASCII (CJK) chars with '*'.
  const js7z = await JS7z({
    print: (text: string) => {
      stdout += text + "\n";
    },
    printErr: (text: string) => {
      stderr += text + "\n";
    },
  });

  const archiveName = getBaseName(filePath);
  js7z.FS.writeFile(`/${archiveName}`, new Uint8Array(data));

  // Dedicated runner — avoids run7z which overwrites js7z.printErr
  await new Promise<void>((resolve, reject) => {
    js7z.onExit = (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`7z l: ${code}\n${stderr}`));
    };
    js7z.callMain(["l", "-slt", "-sccUTF-8", `/${archiveName}`]);
  });

  // Parse `7z l -slt` output line by line: each entry starts
  // with `Path = ...` and contains `Size = ...` / `Attributes = ...`.
  const results: { path: string; size: number; type: string }[] = [];
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

  tryCleanup(js7z);
  return results;
}

/**
 * Check if an archive is encrypted using js7z-tools `7z l -slt -p` command.
 *
 * Strategy:
 *   - Runs listing with empty password
 *   - If listing fails with "encrypted" / "Wrong password" in stderr → encrypted
 *   - If stdout contains "Encrypted = +" → encrypted
 *   - Otherwise → not encrypted
 *
 * This is more reliable than libarchive-wasm's hasEncryptedData() which
 * returns null for 7z format (it can't parse 7z headers).
 *
 * @param filePath - Path to the archive file
 * @returns true=encrypted, false=not encrypted
 */
export async function isEncrypted(filePath: string): Promise<boolean> {
  const data = fs.readFileSync(filePath);
  const js7z = await JS7z();
  let stdout = "";
  let stderr = "";
  js7z.print = (text: string) => {
    stdout += text + "\n";
  };
  js7z.printErr = (text: string) => {
    stderr += text + "\n";
  };

  const archiveName = getBaseName(filePath);
  js7z.FS.writeFile(`/${archiveName}`, new Uint8Array(data));

  try {
    await run7z(js7z, ["l", "-slt", "-p", `/${archiveName}`]);
    // Listing succeeded — check for encryption markers in output
    return stdout.includes("Encrypted = +");
  } catch {
    // Listing failed — check if it was due to encryption
    const lower = stderr.toLowerCase();
    if (lower.includes("encrypted") || lower.includes("wrong password")) {
      return true;
    }
    // Some other error — assume not encrypted, proceed without password
    return false;
  }
}
