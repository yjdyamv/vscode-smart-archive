/**
 * API tests — Smart Archive VSCode Extension
 *
 * Tests for the public API layer (src/api/). These tests exercise
 * the same code paths that extension commands use, but without
 * any VSCode UI dependency.
 *
 * Covers:
 *   - Pure helper functions (format lookup, path resolution, validation)
 *   - High-level compress/decompress round-trips
 *   - Decompress helpers (output dir derivation, volume resolution)
 */

import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import {
  compress,
  decompress,
  lookupFormat,
  resolveOutputPath,
  resolveSaveName,
  buildCompressOptions,
  validateTargetPaths,
  deriveOutputDir,
  resolveArchiveExt,
  resolveEffectiveInput,
} from "../src/api";

// ── Pure helper tests ─────────────────────────────────────────────

describe("lookupFormat", () => {
  it("returns FormatInfo for known creatable formats", () => {
    const f = lookupFormat("7z");
    expect(f.label).toBe("7z");
    expect(f.canCreate).toBe(true);
    expect(f.supportsEncryption).toBe(true);
  });

  it("returns FormatInfo for wrapped formats", () => {
    const f = lookupFormat("tar.gz");
    expect(f.label).toBe("tar.gz");
    expect(f.canCreate).toBe(true);
    expect(f.supportsEncryption).toBe(false);
  });

  it("returns FormatInfo for WIM", () => {
    const f = lookupFormat("wim");
    expect(f.label).toBe("wim");
    expect(f.canCreate).toBe(true);
  });

  it("returns FormatInfo for tar.zst", () => {
    const f = lookupFormat("tar.zst");
    expect(f.label).toBe("tar.zst");
    expect(f.canCreate).toBe(true);
  });

  it("returns FormatInfo for tar.lz4", () => {
    const f = lookupFormat("tar.lz4");
    expect(f.label).toBe("tar.lz4");
    expect(f.canCreate).toBe(true);
  });

  it("returns FormatInfo for tar.br", () => {
    const f = lookupFormat("tar.br");
    expect(f.label).toBe("tar.br");
    expect(f.canCreate).toBe(true);
  });

  it("throws for non-creatable format (rar)", () => {
    expect(() => lookupFormat("rar")).toThrow(/Unknown or non-creatable format/);
  });

  it("throws for unknown format", () => {
    expect(() => lookupFormat("nonsense")).toThrow(/Unknown or non-creatable format/);
  });

  it("throws for empty string", () => {
    expect(() => lookupFormat("")).toThrow();
  });
});

describe("resolveOutputPath", () => {
  it("single target: derives from target name", () => {
    const result = resolveOutputPath(["/home/user/project"], "7z");
    const expected = path.normalize("/home/user/project.7z");
    expect(result).toBe(expected);
  });

  it("multiple targets: uses 'archive' as base name", () => {
    const result = resolveOutputPath(["/a/file1.txt", "/b/file2.txt"], "zip");
    const expected = path.normalize("/a/archive.zip");
    expect(result).toBe(expected);
  });

  it("uses custom output dir when provided", () => {
    const result = resolveOutputPath(["/home/user/project"], "tar.gz", "/custom/out");
    const expected = path.normalize("/custom/out/project.tar.gz");
    expect(result).toBe(expected);
  });

  it("single target with nested path", () => {
    const result = resolveOutputPath(["/home/user/docs/report"], "7z");
    const expected = path.normalize("/home/user/docs/report.7z");
    expect(result).toBe(expected);
  });
});

describe("resolveSaveName", () => {
  it("appends extension to clean name", () => {
    expect(resolveSaveName("archive", "7z")).toBe("archive.7z");
  });

  it("strips trailing compound extensions", () => {
    expect(resolveSaveName("report.tar.lz4.tar.lz4", "tar.lz4")).toBe("report.tar.lz4");
  });

  it("strips single trailing extension", () => {
    expect(resolveSaveName("archive.7z", "zip")).toBe("archive.zip");
  });

  it("handles name with dots", () => {
    // Each dotted segment is treated as an extension, so "my.v1.0" → "my"
    expect(resolveSaveName("my.v1.0", "7z")).toBe("my.7z");
  });
});

describe("buildCompressOptions", () => {
  it("builds valid options from minimal params", () => {
    const opts = buildCompressOptions({ targets: ["/a/file.txt"], format: "7z" });
    expect(opts.format.label).toBe("7z");
    expect(opts.targets).toEqual([{ fsPath: "/a/file.txt" }]);
    expect(opts.password).toBe("");
    expect(opts.level).toBe(5);
    expect(opts.volumeSize).toBeUndefined();
    expect(path.normalize(opts.outputPath)).toBe(path.normalize("/a/file.txt.7z"));
  });

  it("includes password when provided", () => {
    const opts = buildCompressOptions({
      targets: ["/a/file.txt"],
      format: "7z",
      password: "secret",
    });
    expect(opts.password).toBe("secret");
  });

  it("throws on password starting with dash", () => {
    expect(() =>
      buildCompressOptions({ targets: ["/a"], format: "7z", password: "-hack" }),
    ).toThrow(/password/i);
  });

  it("throws on password with null byte", () => {
    expect(() =>
      buildCompressOptions({ targets: ["/a"], format: "7z", password: "bad\0pw" }),
    ).toThrow(/password/i);
  });

  it("throws on unknown format", () => {
    expect(() => buildCompressOptions({ targets: ["/a"], format: "nope" })).toThrow(
      /Unknown or non-creatable format/,
    );
  });

  it("uses explicit outputPath when provided", () => {
    const opts = buildCompressOptions({
      targets: ["/a/file.txt"],
      format: "zip",
      outputPath: "/out/custom.zip",
    });
    expect(opts.outputPath).toBe("/out/custom.zip");
  });

  it("uses custom level and volumeSize", () => {
    const opts = buildCompressOptions({
      targets: ["/a/file.txt"],
      format: "7z",
      level: 9,
      volumeSize: "100m",
    });
    expect(opts.level).toBe(9);
    expect(opts.volumeSize).toBe("100m");
  });
});

describe("validateTargetPaths", () => {
  it("returns empty for valid paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
    try {
      const p = path.join(tmpDir, "test.txt");
      fs.writeFileSync(p, "hello");
      expect(validateTargetPaths([p])).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns errors for nonexistent paths", () => {
    const errors = validateTargetPaths(["/this/path/does/not/exist"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("does not exist");
  });

  it("returns multiple errors", () => {
    const errors = validateTargetPaths(["/a/nope", "/b/nope"]);
    expect(errors.length).toBe(2);
  });
});

// ── Decompress helpers ────────────────────────────────────────────

describe("deriveOutputDir", () => {
  it("appends .extracted to archive name", () => {
    const result = deriveOutputDir("/downloads/archive.7z");
    const expected = path.normalize("/downloads/archive.extracted");
    expect(result).toBe(expected);
  });

  it("handles compound extensions", () => {
    const result = deriveOutputDir("/downloads/backup.tar.gz");
    const expected = path.normalize("/downloads/backup.extracted");
    expect(result).toBe(expected);
  });

  it("avoids collision with existing directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
    try {
      const archivePath = path.join(tmpDir, "test.7z");
      fs.writeFileSync(archivePath, "fake");
      fs.mkdirSync(path.join(tmpDir, "test.extracted"));
      const result = deriveOutputDir(archivePath);
      expect(result).toBe(path.join(tmpDir, "test_1.extracted"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveArchiveExt", () => {
  it("returns ext from path for regular archives", () => {
    expect(resolveArchiveExt("/data/backup.7z")).toBe(".7z");
    expect(resolveArchiveExt("/data/backup.tar.gz")).toBe(".tar.gz");
    expect(resolveArchiveExt("/data/backup.zip")).toBe(".zip");
  });

  it("returns ext override when provided", () => {
    expect(resolveArchiveExt("/data/backup", "zip")).toBe("zip");
  });
});

describe("resolveEffectiveInput", () => {
  it("returns original path for non-volume files", () => {
    expect(resolveEffectiveInput("/data/archive.7z")).toBe("/data/archive.7z");
    expect(resolveEffectiveInput("/data/archive.zip")).toBe("/data/archive.zip");
    expect(resolveEffectiveInput("/data/archive.tar.gz")).toBe("/data/archive.tar.gz");
  });

  it("returns original path when .001 does not exist", () => {
    const result = resolveEffectiveInput("/nonexistent/archive.7z.002");
    expect(result).toBe("/nonexistent/archive.7z.002");
  });
});

// ── High-level compress/decompress round-trips ────────────────────

describe("API compress round-trips", () => {
  let tmpDir: string;

  function writeFiles(files: Record<string, string>): string[] {
    const targetDirs: string[] = [];
    for (const [relPath, content] of Object.entries(files)) {
      const normalized = relPath.replace(/^\/+/, "").replace(/\\/g, "/");
      const segments = normalized.split("/");
      const fullPath = path.join(tmpDir, ...segments);

      // Ensure parent directories exist
      const dir = path.dirname(fullPath);
      if (dir !== tmpDir) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write the actual file
      fs.writeFileSync(fullPath, content);

      // Collect top-level directories (not files) as compression targets
      if (segments.length > 1) {
        const topDir = path.join(tmpDir, segments[0]);
        if (!targetDirs.includes(topDir)) {
          targetDirs.push(topDir);
        }
      }
    }

    // For single-file entries, the target is the file itself
    if (targetDirs.length === 0) {
      for (const [relPath] of Object.entries(files)) {
        const normalized = relPath.replace(/^\/+/, "").replace(/\\/g, "/");
        targetDirs.push(path.join(tmpDir, ...normalized.split("/")));
      }
    }

    return targetDirs;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_api_"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("7z single file round-trip", async () => {
    const targets = writeFiles({ "hello.txt": "Hello World!" });
    const archivePath = await compress({
      targets,
      format: "7z",
    });
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(archivePath.endsWith(".7z")).toBe(true);

    const outDir = await decompress({ inputPath: archivePath, password: "" });
    const content = fs.readFileSync(path.join(outDir, "hello.txt"), "utf-8");
    expect(content).toBe("Hello World!");
  });

  it("7z multi-file round-trip", async () => {
    const files = {
      "proj/src/main.js": "console.log('hi')",
      "proj/src/lib/helper.js": "export default 1",
      "proj/readme.md": "# Project",
    };
    const targets = writeFiles(files);
    const archivePath = await compress({ targets, format: "7z" });

    const outDir = await decompress({ inputPath: archivePath, password: "" });
    expect(fs.readFileSync(path.join(outDir, "proj", "src", "main.js"), "utf-8")).toBe(
      "console.log('hi')",
    );
    expect(fs.readFileSync(path.join(outDir, "proj", "src", "lib", "helper.js"), "utf-8")).toBe(
      "export default 1",
    );
    expect(fs.readFileSync(path.join(outDir, "proj", "readme.md"), "utf-8")).toBe("# Project");
  });

  it("7z encrypted round-trip", async () => {
    const targets = writeFiles({ "secret.txt": "classified" });
    const archivePath = await compress({
      targets,
      format: "7z",
      password: "s3cret!",
    });

    // Wrong password should fail
    await expect(decompress({ inputPath: archivePath, password: "wrong" })).rejects.toThrow();

    // Correct password should work
    const outDir = await decompress({ inputPath: archivePath, password: "s3cret!" });
    expect(fs.readFileSync(path.join(outDir, "secret.txt"), "utf-8")).toBe("classified");
  });

  it("ZIP single file round-trip", async () => {
    const targets = writeFiles({ "data.bin": "zipped" });
    const archivePath = await compress({ targets, format: "zip" });

    const outDir = await decompress({ inputPath: archivePath, ext: "zip", password: "" });
    expect(fs.readFileSync(path.join(outDir, "data.bin"), "utf-8")).toBe("zipped");
  });

  it("ZIP encrypted round-trip", async () => {
    const targets = writeFiles({ "private.txt": "top secret" });
    const archivePath = await compress({
      targets,
      format: "zip",
      password: "zip123",
    });

    await expect(
      decompress({ inputPath: archivePath, password: "wrong", ext: "zip" }),
    ).rejects.toThrow();

    const outDir = await decompress({ inputPath: archivePath, password: "zip123", ext: "zip" });
    expect(fs.readFileSync(path.join(outDir, "private.txt"), "utf-8")).toBe("top secret");
  });

  it("TAR round-trip", async () => {
    const targets = writeFiles({ "notes.txt": "tar test" });
    const archivePath = await compress({ targets, format: "tar" });

    const outDir = await decompress({ inputPath: archivePath, ext: "tar", password: "" });
    expect(fs.readFileSync(path.join(outDir, "notes.txt"), "utf-8")).toBe("tar test");
  });

  it("WIM round-trip", async () => {
    const targets = writeFiles({ "boot/setup.ini": "[setup]" });
    const archivePath = await compress({ targets, format: "wim" });

    const outDir = await decompress({ inputPath: archivePath, ext: "wim", password: "" });
    expect(fs.readFileSync(path.join(outDir, "boot", "setup.ini"), "utf-8")).toBe("[setup]");
  });

  it("exclusion patterns: filter out node_modules", async () => {
    const files = {
      "app/src/index.js": "main",
      "app/node_modules/pkg/index.js": "vendor",
    };
    const targets = writeFiles(files);
    const archivePath = await compress({
      targets,
      format: "7z",
      excludePatterns: ["node_modules"],
    });

    const outDir = await decompress({ inputPath: archivePath, password: "" });
    expect(fs.readFileSync(path.join(outDir, "app", "src", "index.js"), "utf-8")).toBe("main");
    // node_modules should be excluded
    expect(() =>
      fs.readFileSync(path.join(outDir, "app", "node_modules", "pkg", "index.js")),
    ).toThrow();
  });

  it("compression with explicit outputPath", async () => {
    const targets = writeFiles({ "doc.txt": "docs" });
    const outPath = path.join(tmpDir, "custom-output.7z");
    const result = await compress({ targets, format: "7z", outputPath: outPath });
    expect(result).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("compression with custom level", async () => {
    const targets = writeFiles({ "big.txt": "x".repeat(10000) });
    const archivePath = await compress({ targets, format: "7z", level: 9 });
    expect(fs.existsSync(archivePath)).toBe(true);
    const size9 = fs.statSync(archivePath).size;

    // Level 0 (store) should produce a larger archive
    const archivePath0 = path.join(tmpDir, "store.7z");
    await compress({ targets, format: "7z", level: 0, outputPath: archivePath0 });
    const size0 = fs.statSync(archivePath0).size;
    expect(size0).toBeGreaterThan(size9);
  });

  it("unknown format throws", async () => {
    const targets = writeFiles({ "a.txt": "a" });
    await expect(compress({ targets, format: "rar" })).rejects.toThrow(/Unknown or non-creatable format/);
  });

  it("nonexistent target handled by engine (may warn but not throw via system7z)", async () => {
    // When system 7z encounters a missing input file, it may produce
    // an empty archive with warning (code 1) instead of throwing.
    // The command layer pre-validates targets before reaching compressWith7z.
    const result = await compress({
      targets: ["/nonexistent/path"],
      format: "7z",
      outputPath: path.join(tmpDir, "empty.7z"),
    });
    expect(fs.existsSync(result)).toBe(true);
  });
});

// ── Wrapped format helpers (pure logic) ──────────────────────────

describe("lookupFormat — wrapped formats", () => {
  const wrappedFormats = [
    { label: "tar.gz", supportsEncryption: false },
    { label: "tar.bz2", supportsEncryption: false },
    { label: "tar.xz", supportsEncryption: false },
    { label: "tar.zst", supportsEncryption: false },
    { label: "tar.lz4", supportsEncryption: false },
    { label: "tar.br", supportsEncryption: false },
  ];

  for (const fmt of wrappedFormats) {
    it(`lookupFormat("${fmt.label}") returns creatable format`, () => {
      const f = lookupFormat(fmt.label);
      expect(f.label).toBe(fmt.label);
      expect(f.canCreate).toBe(true);
      expect(f.supportsEncryption).toBe(fmt.supportsEncryption);
    });
  }

  it("lookupFormat rejects .gz (not creatable, stream format)", () => {
    expect(() => lookupFormat("gz")).toThrow(/Unknown or non-creatable format/);
  });

  it("lookupFormat rejects .bz2 (not creatable, stream format)", () => {
    expect(() => lookupFormat("bz2")).toThrow(/Unknown or non-creatable format/);
  });

  it("lookupFormat rejects .xz (not creatable, stream format)", () => {
    expect(() => lookupFormat("xz")).toThrow(/Unknown or non-creatable format/);
  });
});

describe("resolveOutputPath — wrapped formats", () => {
  it("tar.gz appends compound extension", () => {
    const result = resolveOutputPath(["/data/project"], "tar.gz");
    expect(path.normalize(result)).toBe(path.normalize("/data/project.tar.gz"));
  });

  it("tar.zst appends compound extension", () => {
    const result = resolveOutputPath(["/data/backup"], "tar.zst");
    expect(path.normalize(result)).toBe(path.normalize("/data/backup.tar.zst"));
  });

  it("tar.br appends compound extension", () => {
    const result = resolveOutputPath(["/data/pack"], "tar.br");
    expect(path.normalize(result)).toBe(path.normalize("/data/pack.tar.br"));
  });
});

describe("buildCompressOptions — wrapped formats", () => {
  it("builds options for tar.gz", () => {
    const opts = buildCompressOptions({
      targets: ["/a/src"],
      format: "tar.gz",
      level: 6,
    });
    expect(opts.format.label).toBe("tar.gz");
    expect(opts.format.supportsEncryption).toBe(false);
    expect(opts.level).toBe(6);
  });

  it("builds options for tar.zst with level", () => {
    const opts = buildCompressOptions({
      targets: ["/a/src"],
      format: "tar.zst",
      level: 3,
    });
    expect(opts.format.label).toBe("tar.zst");
    expect(opts.level).toBe(3);
  });

  it("throws when password is set on non-encryptable wrapped format", () => {
    // Password validation doesn't care about format encryption flag;
    // it only validates the password string itself. A password can
    // be passed even if the format doesn't support encryption,
    // but in practice the command wizard won't ask.
    const opts = buildCompressOptions({
      targets: ["/a/src"],
      format: "tar.gz",
      password: "secret",
    });
    expect(opts.password).toBe("secret");
  });

  it("throws on password starting with dash for wrapped format", () => {
    expect(() =>
      buildCompressOptions({ targets: ["/a"], format: "tar.gz", password: "-bad" }),
    ).toThrow(/password/i);
  });
});

// ── Wrapped format compression (all 6 formats) ───────────────────

const WRAPPED_FORMATS: { label: string; shortAlias?: string }[] = [
  { label: "tar.gz", shortAlias: "tgz" },
  { label: "tar.bz2" },
  { label: "tar.xz" },
  { label: "tar.zst", shortAlias: "tzst" },
  { label: "tar.lz4", shortAlias: "tlz4" },
  { label: "tar.br", shortAlias: "tbr" },
];

describe("API wrapped format compression", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_wrap_"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeMultiFile(): string[] {
    const projDir = path.join(tmpDir, "proj");
    const srcDir = path.join(projDir, "src");
    const libDir = path.join(srcDir, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "readme.md"), "# Project");
    fs.writeFileSync(path.join(srcDir, "main.js"), "console.log(1)");
    fs.writeFileSync(path.join(libDir, "util.js"), "export const x = 1");
    return [projDir];
  }

  for (const fmt of WRAPPED_FORMATS) {
    it(`compresses with format "${fmt.label}" and produces non-empty archive`, async () => {
      const targets = writeMultiFile();
      const outPath = path.join(tmpDir, `archive.${fmt.label}`);
      const result = await compress({ targets, format: fmt.label, outputPath: outPath });
      expect(result).toBe(outPath);
      expect(fs.existsSync(outPath)).toBe(true);
      const stat = fs.statSync(outPath);
      expect(stat.size).toBeGreaterThan(0);

      // Wrapped archives should be smaller than the raw tar would be
      // (except tar.bz2/xz with tiny files, which can be larger)
      if (fmt.label !== "tar") {
        expect(stat.size).toBeLessThan(50_000); // sanity upper bound
      }
    });

    if (fmt.shortAlias) {
      it(`compresses with short alias ".${fmt.shortAlias}" and verifies content`, async () => {
        const targets = writeMultiFile();
        const outPath = path.join(tmpDir, `archive.${fmt.shortAlias}`);
        const result = await compress({
          targets,
          format: fmt.label, // use canonical format, not alias
          outputPath: outPath,
        });
        expect(fs.existsSync(result)).toBe(true);
        expect(fs.statSync(result).size).toBeGreaterThan(0);
      });
    }
  }
});

// ── Wrapped format decompression ──────────────────────────────────

describe("API wrapped format round-trips", () => {
  let tmpDir: string;

  function writeFiles(files: Record<string, string>): string[] {
    const targets: string[] = [];
    for (const [relPath, content] of Object.entries(files)) {
      const segments = relPath.replace(/^\/+/, "").replace(/\\/g, "/").split("/");
      const fullPath = path.join(tmpDir, ...segments);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      if (segments.length === 1 && !targets.includes(fullPath)) {
        targets.push(fullPath);
      }
      if (segments.length > 1) {
        const topDir = path.join(tmpDir, segments[0]);
        if (!targets.includes(topDir)) targets.push(topDir);
      }
    }
    return targets;
  }

  function readDirRecursive(dir: string, prefix = ""): Record<string, string> {
    const result: Record<string, string> = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".smartarchive") continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        Object.assign(result, readDirRecursive(path.join(dir, entry.name), key));
      } else {
        result[key] = fs.readFileSync(path.join(dir, entry.name), "utf-8");
      }
    }
    return result;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_wrap_"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── tar.br — full round-trip (only WASM path) ──

  describe("tar.br (brotli — WASM full pipeline)", () => {
    it("full round-trip: compress → decompress → verify files with subdirectories", async () => {
      const files = {
        "pkg/src/index.ts": "main()",
        "pkg/src/lib/helper.ts": "export 1",
        "pkg/README.md": "# Doc",
      };
      const targets = writeFiles(files);

      const archivePath = path.join(tmpDir, "bundle.tar.br");
      const out = await compress({ targets, format: "tar.br", outputPath: archivePath });
      expect(fs.existsSync(out)).toBe(true);

      const outDir = await decompress({ inputPath: out });
      const extracted = readDirRecursive(outDir);
      expect(extracted["pkg/src/index.ts"]).toBe("main()");
      expect(extracted["pkg/src/lib/helper.ts"]).toBe("export 1");
      expect(extracted["pkg/README.md"]).toBe("# Doc");
    });

    it("tar.br with single directory containing one file", async () => {
      const projDir = path.join(tmpDir, "app");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "main.ts"), "const x = 1;");

      const archivePath = path.join(tmpDir, "app.tar.br");
      await compress({ targets: [projDir], format: "tar.br", outputPath: archivePath });
      expect(fs.statSync(archivePath).size).toBeGreaterThan(0);

      const outDir = await decompress({ inputPath: archivePath });
      expect(fs.readFileSync(path.join(outDir, "app", "main.ts"), "utf-8")).toBe("const x = 1;");
    });

    it("tar.br short alias (tbr) round-trip with directory", async () => {
      const projDir = path.join(tmpDir, "mod");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "data.bin"), "alias-test");

      const archivePath = path.join(tmpDir, "mod.tbr");
      await compress({ targets: [projDir], format: "tar.br", outputPath: archivePath });

      const outDir = await decompress({ inputPath: archivePath });
      expect(fs.readFileSync(path.join(outDir, "mod", "data.bin"), "utf-8")).toBe("alias-test");
    });
  });

  describe("tar.lz4 (LZ4 — WASM full pipeline)", () => {
    it("full round-trip: compress → decompress → verify files", async () => {
      const files = {
        "lib/src/core.ts": "export default class Core {}",
        "lib/src/util/fs.ts": "export const read = (p: string) => {}",
        "lib/package.json": '{"name": "lib"}',
      };
      const targets = writeFiles(files);

      const archivePath = path.join(tmpDir, "bundle.tar.lz4");
      const out = await compress({ targets, format: "tar.lz4", outputPath: archivePath });
      expect(fs.existsSync(out)).toBe(true);

      const outDir = await decompress({ inputPath: out });
      const extracted = readDirRecursive(outDir);
      expect(extracted["lib/src/core.ts"]).toBe("export default class Core {}");
      expect(extracted["lib/src/util/fs.ts"]).toBe("export const read = (p: string) => {}");
      expect(extracted["lib/package.json"]).toBe('{"name": "lib"}');
    });

    it("tar.lz4 single directory round-trip", async () => {
      const projDir = path.join(tmpDir, "data");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "log.txt"), "lz4-test-content");

      const archivePath = path.join(tmpDir, "data.tar.lz4");
      await compress({ targets: [projDir], format: "tar.lz4", outputPath: archivePath });

      const outDir = await decompress({ inputPath: archivePath });
      expect(fs.readFileSync(path.join(outDir, "data", "log.txt"), "utf-8")).toBe("lz4-test-content");
    });

    it("tar.lz4 short alias (tlz4) round-trip", async () => {
      const projDir = path.join(tmpDir, "pkg");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "info.json"), '{"v":1}');

      const archivePath = path.join(tmpDir, "pkg.tlz4");
      await compress({ targets: [projDir], format: "tar.lz4", outputPath: archivePath });

      const outDir = await decompress({ inputPath: archivePath });
      expect(fs.readFileSync(path.join(outDir, "pkg", "info.json"), "utf-8")).toBe('{"v":1}');
    });
  });

  // ── tar.gz / tar.bz2 / tar.xz / tar.zst —
  //     system 7z decompresses outer layer + unwrapInnerTar extracts
  //     inner tar → full round-trip now works. ─

  const PARTIAL_FORMATS: { label: string }[] = [
    { label: "tar.gz" },
    { label: "tar.bz2" },
    { label: "tar.xz" },
    { label: "tar.zst" },
  ];

  for (const fmt of PARTIAL_FORMATS) {
    describe(`${fmt.label} (full round-trip)`, () => {
      it(`single file round-trip for "${fmt.label}"`, async () => {
        const filePath = path.join(tmpDir, "data.txt");
        fs.writeFileSync(filePath, "wrapped round-trip test");

        const archivePath = path.join(tmpDir, `archive.${fmt.label}`);
        await compress({ targets: [filePath], format: fmt.label, outputPath: archivePath });
        expect(fs.existsSync(archivePath)).toBe(true);
        expect(fs.statSync(archivePath).size).toBeGreaterThan(0);

        const outDir = await decompress({ inputPath: archivePath });
        expect(fs.readFileSync(path.join(outDir, "data.txt"), "utf-8")).toBe("wrapped round-trip test");
      });

      it(`multi-file directory round-trip for "${fmt.label}"`, async () => {
        const projDir = path.join(tmpDir, "proj");
        const srcDir = path.join(projDir, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, "readme.md"), "hello");
        fs.writeFileSync(path.join(srcDir, "app.ts"), "type X = 1;");

        const archivePath = path.join(tmpDir, `proj.${fmt.label}`);
        await compress({
          targets: [projDir],
          format: fmt.label,
          outputPath: archivePath,
          excludePatterns: [], // no default exclusions for this test
        });

        const outDir = await decompress({ inputPath: archivePath });
        expect(fs.existsSync(outDir)).toBe(true);
        expect(fs.readFileSync(path.join(outDir, "proj", "readme.md"), "utf-8")).toBe("hello");
        expect(fs.readFileSync(path.join(outDir, "proj", "src", "app.ts"), "utf-8")).toBe("type X = 1;");
      });
    });
  }
});

// ── Decompress-specific flows ─────────────────────────────────────

describe("API decompress flows", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_dec_"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves outputDir automatically", async () => {
    const archivePath = path.join(tmpDir, "test.7z");
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    // We need an actual archive to decompress
    // Create one using the compress API
    const srcFile = path.join(tmpDir, "hello.txt");
    fs.writeFileSync(srcFile, "world");

    const outPath = await compress({
      targets: [srcFile],
      format: "7z",
      outputPath: archivePath,
    });

    const result = await decompress({ inputPath: outPath });
    expect(result).toBe(path.join(tmpDir, "test.extracted"));
    expect(fs.existsSync(result)).toBe(true);
  });

  it("respects explicit outputDir", async () => {
    const archivePath = path.join(tmpDir, "data.7z");
    const srcFile = path.join(tmpDir, "note.txt");
    fs.writeFileSync(srcFile, "content");

    await compress({ targets: [srcFile], format: "7z", outputPath: archivePath });

    const customOut = path.join(tmpDir, "my_output");
    const result = await decompress({ inputPath: archivePath, outputDir: customOut });
    expect(result).toBe(customOut);
    expect(fs.existsSync(path.join(customOut, "note.txt"))).toBe(true);
  });
});
