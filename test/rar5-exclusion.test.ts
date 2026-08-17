/**
 * rar5 exclusion & structure verification — Smart Archiver
 *
 * Proves the exclusion pipeline end-to-end for RAR5 creation:
 * default noisy-dir patterns (COMPRESS_EXCLUDE_DEFAULTS) and custom
 * patterns must keep excluded files AND directories out of the produced
 * archive, empty directories must be preserved, and symlinks must be
 * followed. Listing is done with the bundled full-format 7zz, which can
 * read RAR5.
 */
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compress } from "../src/api/compress";
import { COMPRESS_EXCLUDE_DEFAULTS } from "../src/constants";
import { bundled7zPath } from "../src/engines/bundled7z";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

// Same resolution as the bundled7zz gate (never a hand-rolled vendor path);
// every use is inside it.runIf(gate("bundled7zz")), so non-null there.
const BUNDLED_7ZZ = bundled7zPath()!;

function listArchive(rarPath: string): string[] {
  const out = childProcess.execFileSync(BUNDLED_7ZZ, ["l", rarPath], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    // Windows 7zz lists entries with backslashes; the tests assert on
    // forward-slash paths.
    .map((l) => l.replace(/\\/g, "/"))
    .filter(
      (l) =>
        l &&
        !l.startsWith("-") &&
        !/^Size|^----|file\(s\)|Dir\(s\)|Packed|Ratio|Method|Name/i.test(l),
    );
}

describe("rar5 exclusion pipeline", () => {
  let dir: string;
  let proj: string;
  beforeAll(() => {
    dir = tmpDir("rarexc-");
    proj = path.join(dir, "proj");
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.mkdirSync(path.join(proj, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.mkdirSync(path.join(proj, "dist"), { recursive: true });
    fs.mkdirSync(path.join(proj, "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(proj, "keep"), { recursive: true });
    fs.mkdirSync(path.join(proj, "empty"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "main.js"), "console.log(1);\n");
    fs.writeFileSync(path.join(proj, "src", "debug.log"), "log noise\n");
    fs.writeFileSync(path.join(proj, "node_modules", "pkg", "index.js"), "noise\n");
    fs.writeFileSync(path.join(proj, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(proj, "dist", "bundle.js"), "noise\n");
    fs.writeFileSync(path.join(proj, "__pycache__", "m.cpython-312.pyc"), "noise\n");
    fs.writeFileSync(path.join(proj, "keep", "data.txt"), "keep me\n");
    fs.writeFileSync(path.join(dir, "extra.txt"), "extra\n");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.runIf(gate("bundled7zz"))(
    "default noisy-dir patterns keep node_modules/.git/dist/__pycache__ out",
    async () => {
      const outPath = path.join(dir, "defaults.rar");
      await compress({
        targets: [proj],
        format: "rar",
        level: 1,
        outputPath: outPath,
        // Simulate the command layer default when no user config is set.
        excludePatterns: COMPRESS_EXCLUDE_DEFAULTS,
      });

      const joined = listArchive(outPath).join("\n");
      expect(joined).toContain("src/main.js");
      expect(joined).toContain("keep/data.txt");
      expect(joined).not.toContain("node_modules");
      expect(joined).not.toContain(".git");
      expect(joined).not.toContain("dist/");
      expect(joined).not.toContain("__pycache__");
    },
  );

  it.runIf(gate("bundled7zz"))("custom patterns exclude files and directories", async () => {
    const outPath = path.join(dir, "custom.rar");
    await compress({
      targets: [proj],
      format: "rar",
      level: 1,
      outputPath: outPath,
      excludePatterns: ["keep", "dist", "**/node_modules", "**/*.log"],
    });

    const joined = listArchive(outPath).join("\n");
    expect(joined).not.toContain("keep");
    expect(joined).not.toContain("dist");
    expect(joined).not.toContain("node_modules");
    expect(joined).not.toContain(".log");
    expect(joined).toContain("src/main.js");
  });

  it.runIf(gate("bundled7zz"))("multi-target: noisy dirs still excluded", async () => {
    const outPath = path.join(dir, "multi.rar");
    await compress({
      targets: [proj, path.join(dir, "extra.txt")],
      format: "rar",
      level: 1,
      outputPath: outPath,
      excludePatterns: COMPRESS_EXCLUDE_DEFAULTS,
    });
    const joined = listArchive(outPath).join("\n");
    expect(joined).not.toContain("node_modules");
    expect(joined).toContain("extra.txt");
  });

  it.runIf(gate("bundled7zz"))("empty directories are preserved", async () => {
    const outPath = path.join(dir, "empty.rar");
    await compress({
      targets: [proj],
      format: "rar",
      level: 1,
      outputPath: outPath,
      excludePatterns: COMPRESS_EXCLUDE_DEFAULTS,
    });
    const joined = listArchive(outPath).join("\n");
    expect(joined).toContain("empty");
  });

  it.runIf(gate("bundled7zz"))("symlinks are followed (file and directory)", async () => {
    const linkedFile = path.join(proj, "src", "link.txt");
    const linkedDir = path.join(proj, "keep", "linkdir");
    try {
      fs.symlinkSync(path.join(dir, "extra.txt"), linkedFile);
      fs.symlinkSync(path.join(proj, "src"), linkedDir);
    } catch {
      return; // filesystem without symlink support
    }

    const outPath = path.join(dir, "symlink.rar");
    await compress({
      targets: [proj],
      format: "rar",
      level: 1,
      outputPath: outPath,
      excludePatterns: COMPRESS_EXCLUDE_DEFAULTS,
    });

    const joined = listArchive(outPath).join("\n");
    expect(joined).toContain("link.txt");
    expect(joined).toContain("linkdir/main.js");
  });
});
