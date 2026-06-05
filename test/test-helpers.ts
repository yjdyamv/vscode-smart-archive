/**
 * Production-path test helpers — Smart Archive VSCode Extension
 *
 * High-level compress/decompress helpers that delegate to the public
 * API layer (src/api/). Tests using these helpers exercise the FULL
 * production code path: format dispatching, system7z vs WASM routing,
 * exclude patterns, volume sizes, password validation, wrapped format
 * creation/extraction, progress reporting, and cancellation.
 *
 * @module test/test-helpers
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compress, decompress } from "../src/api";

// ── Types ──────────────────────────────────────────────────────────

/** Supported format labels for testCompress (all canCreate formats) */
type TestFormat =
  | "7z" | "zip" | "tar" | "wim"
  | "tar.gz" | "tar.bz2" | "tar.xz"
  | "tar.zst" | "tar.lz4" | "tar.br";

export interface TestCompressOptions {
  password?: string;
  level?: number;
  volumeSize?: string;
  excludePatterns?: string[];
}

export interface TestDecompressOptions {
  password?: string;
  ext?: string;
}

// ── Compress ───────────────────────────────────────────────────────

export async function testCompress(
  files: Record<string, string>,
  format: TestFormat,
  options: TestCompressOptions = {},
): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcomp_"));
  try {
    const stageDir = path.join(tmpDir, "_stage");
    fs.mkdirSync(stageDir, { recursive: true });

    for (const [fp, content] of Object.entries(files)) {
      const normalized = fp.replace(/^\/+/, "").replace(/\\/g, "/");
      const local = path.join(stageDir, ...normalized.split("/"));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, content);
    }

    const topLevel = new Set<string>();
    for (const fp of Object.keys(files)) {
      const normalized = fp.replace(/^\/+/, "").replace(/\\/g, "/");
      const firstSeg = normalized.split("/")[0];
      topLevel.add(firstSeg);
    }

    const targets = [...topLevel].map((seg) => path.join(stageDir, seg));
    const outputPath = path.join(tmpDir, `output.${format}`);

    await compress({
      targets,
      format,
      outputPath,
      password: options.password ?? "",
      level: options.level ?? 5,
      volumeSize: options.volumeSize,
      excludePatterns: options.excludePatterns,
    });

    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Decompress ─────────────────────────────────────────────────────

export async function testDecompress(
  archiveBuffer: Buffer,
  options: TestDecompressOptions = {},
): Promise<Record<string, string>> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdec_"));
  try {
    const archiveName = options.ext ? `archive.${options.ext}` : "archive.7z";
    const archivePath = path.join(tmpDir, archiveName);
    fs.writeFileSync(archivePath, archiveBuffer);

    const outputDir = path.join(tmpDir, "out");

    await decompress({
      inputPath: archivePath,
      outputDir,
      password: options.password ?? "",
    });

    // Walk output dir and collect files
    const result: Record<string, string> = {};
    function walk(dir: string, prefix: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        if (entry.name === ".smartarchive") continue;
        const full = path.join(dir, entry.name);
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, key);
        } else if (entry.isFile()) {
          result[key] = fs.readFileSync(full, "utf-8");
        }
      }
    }
    walk(outputDir, "");
    return result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
