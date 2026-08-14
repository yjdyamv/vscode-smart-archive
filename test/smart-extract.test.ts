/**
 * Smart extract tests — Smart Archive VSCode Extension
 *
 * Covers:
 *  - promoteSingleTopDirectory unit behavior (single dir / single file /
 *    multiple entries / empty / collisions)
 *  - Full-pipeline integration: extracting an archive with one top-level
 *    folder collapses the wrapper; archives with multiple entries keep
 *    their structure; smartExtract=false restores the old behavior.
 */

import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { promoteSingleTopDirectory } from "../src/utils/smart-extract";
import { decompress } from "../src/api/decompress";
import { compress } from "../src/api/compress";
import { tmpDir } from "./tmp";

beforeEach(() => {
  vscode.__resetVscodeMock();
});

// ════════════════════════════════════════════════════════════════════
// Unit: promoteSingleTopDirectory
// ════════════════════════════════════════════════════════════════════

describe("promoteSingleTopDirectory (unit)", () => {
  it("collapses a single wrapper directory into the output dir", () => {
    const d = tmpDir("se_promote_");
    const wrapper = path.join(d, "App-1.0");
    fs.mkdirSync(path.join(wrapper, "src"), { recursive: true });
    fs.writeFileSync(path.join(wrapper, "readme.md"), "hi");
    fs.writeFileSync(path.join(wrapper, "src", "main.js"), "x");

    const moved = promoteSingleTopDirectory(d);

    expect(moved).toBe(2);
    expect(fs.existsSync(path.join(d, "readme.md"))).toBe(true);
    expect(fs.existsSync(path.join(d, "src", "main.js"))).toBe(true);
    expect(fs.existsSync(wrapper)).toBe(false);
    expect(fs.existsSync(path.join(d, "App-1.0"))).toBe(false);
  });

  it("does nothing when the output dir has multiple top-level entries", () => {
    const d = tmpDir("se_multi_");
    fs.mkdirSync(path.join(d, "a"), { recursive: true });
    fs.mkdirSync(path.join(d, "b"), { recursive: true });
    fs.writeFileSync(path.join(d, "a", "1.txt"), "1");
    fs.writeFileSync(path.join(d, "b", "2.txt"), "2");

    const moved = promoteSingleTopDirectory(d);

    expect(moved).toBe(0);
    expect(fs.existsSync(path.join(d, "a", "1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(d, "b", "2.txt"))).toBe(true);
  });

  it("does nothing when the only entry is a file", () => {
    const d = tmpDir("se_file_");
    fs.writeFileSync(path.join(d, "single.txt"), "data");

    const moved = promoteSingleTopDirectory(d);

    expect(moved).toBe(0);
    expect(fs.existsSync(path.join(d, "single.txt"))).toBe(true);
  });

  it("does nothing when the output dir is empty", () => {
    const d = tmpDir("se_empty_");
    expect(promoteSingleTopDirectory(d)).toBe(0);
  });

  it("does nothing when the only entry is not a directory (symlink)", () => {
    const d = tmpDir("se_link_");
    const target = path.join(d, "..", `se_link_target_${Date.now()}`);
    fs.writeFileSync(target, "t");
    try {
      fs.symlinkSync(target, path.join(d, "link"));
    } catch {
      return; // filesystem without symlink support
    }
    try {
      expect(promoteSingleTopDirectory(d)).toBe(0);
      expect(fs.existsSync(path.join(d, "link"))).toBe(true);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it("collapses a wrapper whose name starts with a dot", () => {
    const d = tmpDir("se_dot_");
    const wrapper = path.join(d, ".hidden");
    fs.mkdirSync(wrapper, { recursive: true });
    fs.writeFileSync(path.join(wrapper, "config.json"), "{}");

    const moved = promoteSingleTopDirectory(d);

    expect(moved).toBe(1);
    expect(fs.existsSync(path.join(d, "config.json"))).toBe(true);
    expect(fs.existsSync(wrapper)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Integration: full compress → decompress pipeline
// ════════════════════════════════════════════════════════════════════

describe("smart extract (full pipeline)", () => {
  async function compressToZip(
    files: Record<string, string>,
  ): Promise<{ archive: string; dir: string }> {
    const work = tmpDir("se_int_");
    const stage = path.join(work, "stage");
    fs.mkdirSync(stage, { recursive: true });
    for (const [fp, content] of Object.entries(files)) {
      const local = path.join(stage, ...fp.replace(/\\/g, "/").split("/"));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, content);
    }
    const topLevel = [...new Set(Object.keys(files).map((fp) => fp.split("/")[0]))];
    const archive = path.join(work, "out.zip");
    await compress({
      targets: topLevel.map((t) => path.join(stage, t)),
      format: "zip",
      outputPath: archive,
    });
    return { archive, dir: work };
  }

  it("collapses a single top-level folder (App-1.0/ → contents)", async () => {
    const { archive, dir } = await compressToZip({
      "App-1.0/readme.md": "hi",
      "App-1.0/src/main.js": "x",
    });
    try {
      const out = await decompress({ inputPath: archive });

      expect(fs.existsSync(path.join(out, "readme.md"))).toBe(true);
      expect(fs.existsSync(path.join(out, "src", "main.js"))).toBe(true);
      // The wrapper must be gone
      expect(fs.existsSync(path.join(out, "App-1.0"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps structure when there are multiple top-level entries", async () => {
    const { archive, dir } = await compressToZip({
      "docs/readme.md": "hi",
      "src/main.js": "x",
    });
    try {
      const out = await decompress({ inputPath: archive });

      expect(fs.existsSync(path.join(out, "docs", "readme.md"))).toBe(true);
      expect(fs.existsSync(path.join(out, "src", "main.js"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the wrapper when smartExtract=false", async () => {
    const { archive, dir } = await compressToZip({
      "App-1.0/readme.md": "hi",
    });
    try {
      const out = await decompress({ inputPath: archive, smartExtract: false });

      expect(fs.existsSync(path.join(out, "App-1.0", "readme.md"))).toBe(true);
      expect(fs.existsSync(path.join(out, "readme.md"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects the smartExtract setting when the option is omitted", async () => {
    const { archive, dir } = await compressToZip({
      "App-1.0/readme.md": "hi",
    });
    try {
      // Setting off → old behavior; option not passed → setting wins.
      vscode.__setConfig("smart-archive", "smartExtract", false);
      const outOff = await decompress({ inputPath: archive });
      expect(fs.existsSync(path.join(outOff, "App-1.0", "readme.md"))).toBe(true);

      vscode.__setConfig("smart-archive", "smartExtract", true);
      const outOn = await decompress({ inputPath: archive });
      expect(fs.existsSync(path.join(outOn, "readme.md"))).toBe(true);
      expect(fs.existsSync(path.join(outOn, "App-1.0"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
