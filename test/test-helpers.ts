/**
 * Production-path test helpers — Smart Archive VSCode Extension
 *
 * High-level compress/decompress helpers that call the REAL production
 * functions (compressWith7z, decompressWith7z). Tests using these helpers
 * exercise the full code path including:
 *   - format dispatching (system 7z vs WASM routing)
 *   - exclude pattern handling (-xr! flag generation, target-name filtering)
 *   - volume size conversion (toBinaryVolumeSize)
 *   - password validation (validatePassword)
 *   - wrapped format creation (createTarFile + codec compression)
 *   - progress reporting and cancellation infrastructure
 *
 * Prior to these helpers, tests called JS7z.callMain() directly with raw
 * 7z CLI arguments, bypassing every piece of production logic. A green
 * test suite proved nothing about whether actual compression worked.
 *
 * @module test/test-helpers
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { CompressOptions, DecompressOptions, FormatInfo } from "../src/types";
import { compressWith7z } from "../src/engines/js7z-compress";
import { decompressWith7z } from "../src/engines/js7z-decompress";
import { COMPRESS_FORMATS } from "../src/constants";

// ── Format lookup ─────────────────────────────────────────────────

/** Supported format labels for testCompress (all canCreate formats) */
type TestFormat =
  | "7z" | "zip" | "tar" | "wim"
  | "tar.gz" | "tar.bz2" | "tar.xz"
  | "tar.zst" | "tar.lz4" | "tar.br";

function lookupFormat(label: string): FormatInfo {
  const found = COMPRESS_FORMATS.find((f) => f.label === label);
  if (!found) throw new Error(`Unsupported test format: "${label}"`);
  return found;
}

// ── Compress ───────────────────────────────────────────────────────

export interface TestCompressOptions {
  /** AES encryption password */
  password?: string;
  /** Compression level (0=store, 9=ultra, default 5) */
  level?: number;
  /** Split archive into volumes (e.g. "10m", "100m", "1g") */
  volumeSize?: string;
  /** Exclusion patterns (e.g. ["node_modules", "*.log"]) */
  excludePatterns?: string[];
}

/**
 * Compress files using the REAL compressWith7z production pipeline.
 * Files are written to a real temp directory, compressed, and the
 * resulting archive buffer is returned.
 *
 * Exercises: format dispatching, password validation,
 * volumeSize→toBinaryVolumeSize, exclude pattern handling,
 * wrapped format creation (tar.gz/bz2/xz/zst/lz4/br),
 * progress reporting infrastructure, cancellation guards.
 *
 * @example
 *   const buf = await testCompress(
 *     { "hello.txt": "world", "sub/data.txt": "data" },
 *     "7z",
 *     { password: "secret", level: 9 },
 *   );
 */
export async function testCompress(
  files: Record<string, string>,
  format: TestFormat,
  options: TestCompressOptions = {},
): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcomp_"));
  try {
    // Write files to real filesystem under a staging subdirectory
    const stageDir = path.join(tmpDir, "_stage");
    fs.mkdirSync(stageDir, { recursive: true });

    for (const [fp, content] of Object.entries(files)) {
      const normalized = fp.replace(/^\/+/, "").replace(/\\/g, "/");
      const local = path.join(stageDir, ...normalized.split("/"));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, content);
    }

    // Determine top-level entries to pass as targets (mirrors user selecting
    // files/folders in explorer). This preserves directory structure in the
    // archive, matching how compressWith7z is called in production.
    const topLevel = new Set<string>();
    for (const fp of Object.keys(files)) {
      const normalized = fp.replace(/^\/+/, "").replace(/\\/g, "/");
      const firstSeg = normalized.split("/")[0];
      topLevel.add(firstSeg);
    }

    const targets: { fsPath: string }[] = [];
    for (const seg of topLevel) {
      targets.push({ fsPath: path.join(stageDir, seg) });
    }

    const outputPath = path.join(tmpDir, `output.${format}`);
    const compressOpts: CompressOptions = {
      targets,
      format: lookupFormat(format),
      outputPath,
      password: options.password ?? "",
      level: options.level ?? 5,
      volumeSize: options.volumeSize,
    };

    await compressWith7z(compressOpts, undefined, undefined, options.excludePatterns);

    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Decompress ─────────────────────────────────────────────────────

export interface TestDecompressOptions {
  /** Decryption password */
  password?: string;
  /** File extension for format detection (e.g. "7z", "tar.gz"). Required for wrapped formats. */
  ext?: string;
}

/**
 * Decompress an archive buffer using the REAL decompressWith7z pipeline.
 * Returns a flat map of relative file paths to their string contents.
 *
 * Exercises: format auto-detection, password validation,
 * wrapped format unwrapping (tar.gz/bz2/xz/zst/lz4/br inner tar),
 * split volume reassembly, streamToVFS, copyDirFromFS,
 * .smartarchive filtering, file size limits.
 *
 * @example
 *   const files = await testDecompress(buf);
 *   // files = { "hello.txt": "world", "sub/data.txt": "data" }
 */
export async function testDecompress(
  archiveBuffer: Buffer,
  options: TestDecompressOptions = {},
): Promise<Record<string, string>> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdec_"));
  try {
    // Write archive to real filesystem (with extension for format detection)
    const archiveName = options.ext ? `archive.${options.ext}` : "archive.7z";
    const archivePath = path.join(tmpDir, archiveName);
    fs.writeFileSync(archivePath, archiveBuffer);

    const outputDir = path.join(tmpDir, "out");
    const decompressOpts: DecompressOptions = {
      inputPath: archivePath,
      outputDir,
      password: options.password ?? "",
    };

    await decompressWith7z(decompressOpts, undefined);

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
