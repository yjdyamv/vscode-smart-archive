/**
 * libarchive-wasm engine wrapper — Smart Archive VSCode Extension
 *
 * Wraps libarchive-wasm (libarchive compiled to WebAssembly) for archive
 * extraction. Used as the primary RAR extraction engine and a fallback
 * for all other formats when js7z-tools fails.
 *
 * Unlike libarchive.js, libarchive-wasm:
 *   - Runs synchronously in the main thread (no web workers)
 *   - Accepts Int8Array directly (no Blob/File wrapping)
 *   - Supports password-protected archives natively
 *   - Has a simpler iterator-based API
 *   - Extraction only (no archive creation)
 *
 * @see https://github.com/ofk/libarchive-wasm
 * @module engines/libarchive-engine
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ArchiveReader, libarchiveWasm } from "libarchive-wasm";
import type { LibarchiveWasm } from "libarchive-wasm";
import type { DecompressOptions } from "../types";
import { safeJoinPath, checkFileSize, checkTotalSize } from "../utils/security";
import { fixArchiveEncoding } from "../utils/path";

/** Singleton WASM module — initialized once and reused */
let wasmModule: LibarchiveWasm | null = null;

/**
 * Lazily initialize the libarchive WASM module.
 * The module is shared across all extraction calls.
 */
async function getWasmModule(): Promise<LibarchiveWasm> {
  if (!wasmModule) {
    wasmModule = await libarchiveWasm();
  }
  return wasmModule;
}

/** Pre-warm the WASM module (call during extension activation). */
export async function prewarmLibarchive(): Promise<void> {
  await getWasmModule();
}

/**
 * Extract an archive using libarchive-wasm.
 *
 * Supports all formats libarchive can read: ZIP, 7z, RAR v4/v5, TAR,
 * GZip, BZip2, XZ, and more.
 *
 * @param options - Decompression options (inputPath, outputDir, password)
 * @returns Number of extracted files
 */
export async function extractArchive(
  options: DecompressOptions,
  token?: vscode.CancellationToken,
): Promise<number> {
  const mod = await getWasmModule();

  // Read archive into memory
  const buffer = fs.readFileSync(options.inputPath);
  const reader = new ArchiveReader(mod, new Int8Array(buffer), options.password || undefined);

  let fileCount = 0;
  let totalSize = 0;

  try {
    for (const entry of reader.entries()) {
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      const pathname = fixArchiveEncoding(entry.getPathname());
      if (!pathname) continue;

      // Security: prevent Zip Slip / path traversal
      const outPath = safeJoinPath(options.outputDir, pathname);

      // Check if it's a directory
      const fileType = entry.getFiletype();
      if (fileType === "DIRECTORY" || pathname.endsWith("/")) {
        fs.mkdirSync(outPath, { recursive: true });
        continue;
      }

      // Ensure parent directory exists
      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });

      // Security: prevent zip bomb — check reported size before allocating
      const reportedSize = entry.getSize();
      checkFileSize(reportedSize);
      totalSize = checkTotalSize(totalSize, reportedSize);

      // Read and write file data
      const data = entry.readData();
      if (data) {
        if (data.byteLength > reportedSize * 4 && reportedSize > 1024) {
          throw new Error(
            `Decompression bomb: reported ${reportedSize}B but decompressed to ${data.byteLength}B`,
          );
        }
        fs.writeFileSync(outPath, Buffer.from(data));
        fileCount++;
      }
    }
  } finally {
    reader.free();
  }

  return fileCount;
}

/**
 * List files in an archive without extracting them.
 *
 * @param filePath - Path to the archive file
 * @returns Array of { path, size, type } entries
 */
export async function getFileList(
  filePath: string,
): Promise<{ path: string; size: number; type: string }[]> {
  const mod = await getWasmModule();
  const buffer = fs.readFileSync(filePath);
  const reader = new ArchiveReader(mod, new Int8Array(buffer));

  const results: { path: string; size: number; type: string }[] = [];
  try {
    for (const entry of reader.entries()) {
      const pathname = fixArchiveEncoding(entry.getPathname());
      if (!pathname) continue;
      results.push({
        path: pathname,
        size: entry.getSize(),
        type: entry.getFiletype(),
      });
    }
  } finally {
    reader.free();
  }

  return results;
}

/**
 * Extract only selected files from an archive.
 *
 * Iterates through all entries and extracts only those whose pathname
 * (after encoding fix) matches a path in the selected set.
 *
 * @param filePath - Path to the archive file
 * @param outputDir - Output directory
 * @param selectedPaths - Array of archive-internal paths to extract
 * @returns Number of extracted files
 */
export async function extractSelectedFiles(
  filePath: string,
  outputDir: string,
  selectedPaths: string[],
  password?: string,
  token?: vscode.CancellationToken,
): Promise<number> {
  const mod = await getWasmModule();
  const buffer = fs.readFileSync(filePath);
  const reader = new ArchiveReader(mod, new Int8Array(buffer), password || undefined);
  const selected = new Set(selectedPaths);
  let fileCount = 0;
  let totalSize = 0;

  try {
    for (const entry of reader.entries()) {
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      const pathname = fixArchiveEncoding(entry.getPathname());
      if (!pathname || !selected.has(pathname)) continue;

      const outPath = safeJoinPath(outputDir, pathname);
      const fileType = entry.getFiletype();

      if (fileType === "DIRECTORY" || pathname.endsWith("/")) {
        fs.mkdirSync(outPath, { recursive: true });
        continue;
      }

      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });

      const data = entry.readData();
      if (data) {
        checkFileSize(data.byteLength);
        totalSize = checkTotalSize(totalSize, data.byteLength);
        fs.writeFileSync(outPath, Buffer.from(data));
        fileCount++;
      }
    }
  } finally {
    reader.free();
  }

  return fileCount;
}
