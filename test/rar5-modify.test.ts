/**
 * Rebuild-based RAR modification tests — Smart Archive
 *
 * Covers the rar5-modify core: archive guards (RAR5 vs RAR4 vs
 * multi-volume), path-escape protection, and the extract → mutate →
 * re-compress → atomic-swap rebuild pipeline.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/engines/system7z", () => ({
  decompressWithSystem7z: vi.fn(),
}));
vi.mock("../src/engines/rar5-engine", () => ({
  compressWithRar5: vi.fn(),
}));

import { decompressWithSystem7z } from "../src/engines/system7z";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import * as vscode from "vscode";
import {
  assertRarModifiable,
  detectRarVersion,
  archiveJoin,
  rebuildRarArchive,
  copyIntoArchive,
} from "../src/providers/archive/rar5-modify";
import { prepareExclusions } from "../src/utils/exclude";

const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

function fakeArchive(dir: string, name: string, sig: Buffer = RAR5_SIG): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, sig);
  return p;
}

function extractFixtureTree(outputDir: string): void {
  fs.mkdirSync(path.join(outputDir, "proj", "src"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "proj", "a.txt"), "aaa");
  fs.writeFileSync(path.join(outputDir, "proj", "src", "main.js"), "js");
  fs.writeFileSync(path.join(outputDir, "top.txt"), "top");
}

describe("assertRarModifiable", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5m-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts single-volume RAR files regardless of version", () => {
    expect(() => assertRarModifiable(fakeArchive(dir, "a.rar"))).not.toThrow();
    expect(() => assertRarModifiable(fakeArchive(dir, "old.rar", RAR4_SIG))).not.toThrow();
  });

  it("rejects multi-volume archives", () => {
    const p = fakeArchive(dir, "a.part1.rar");
    expect(() => assertRarModifiable(p)).toThrow(/volume|分卷/i);
    const r00 = fakeArchive(dir, "a.r00");
    expect(() => assertRarModifiable(r00)).toThrow(/volume|分卷/i);
  });

  it("rejects non-RAR extensions", () => {
    expect(() => assertRarModifiable(path.join(dir, "a.zip"))).toThrow();
  });
});

describe("detectRarVersion", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5v-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sniffs RAR5, RAR4 and unknown signatures", () => {
    expect(detectRarVersion(fakeArchive(dir, "a.rar"))).toBe("rar5");
    expect(detectRarVersion(fakeArchive(dir, "old.rar", RAR4_SIG))).toBe("rar4");
    const p = path.join(dir, "junk.rar");
    fs.writeFileSync(p, "not a rar");
    expect(detectRarVersion(p)).toBe("unknown");
  });
});

describe("archiveJoin", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5j-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("joins nested archive paths onto the root", () => {
    expect(archiveJoin(root, "proj/src/main.js")).toBe(path.join(root, "proj", "src", "main.js"));
  });

  it("normalizes backslash separators", () => {
    expect(archiveJoin(root, "proj\\src\\main.js")).toBe(path.join(root, "proj", "src", "main.js"));
  });

  it("rejects path traversal escapes", () => {
    expect(() => archiveJoin(root, "../evil")).toThrow();
    expect(() => archiveJoin(root, "proj/../../evil")).toThrow();
  });
});

describe("rebuildRarArchive", () => {
  let dir: string;
  let archivePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5r-"));
    archivePath = fakeArchive(dir, "out.rar");
    vi.clearAllMocks();

    vi.mocked(decompressWithSystem7z).mockImplementation(async (opts) => {
      extractFixtureTree(opts.outputDir);
    });
    vi.mocked(compressWithRar5).mockImplementation(async (opts) => {
      fs.writeFileSync(opts.outputPath, RAR5_SIG);
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("extracts, mutates, re-compresses and swaps atomically", async () => {
    await rebuildRarArchive({
      archivePath,
      mutate: (root) => {
        fs.rmSync(path.join(root, "proj", "a.txt"), { force: true });
      },
    });

    // Decompress got the archive (no password by default).
    expect(decompressWithSystem7z).toHaveBeenCalledWith(
      expect.objectContaining({ inputPath: archivePath, password: "" }),
      undefined,
      undefined,
    );

    // Re-compress targeted every top-level entry of the extracted tree.
    const compressCall = vi.mocked(compressWithRar5).mock.calls[0];
    expect(compressCall[0].format.label).toBe("rar");
    expect(compressCall[0].password).toBe("");
    expect(compressCall[0].level).toBe(5);
    const targets = compressCall[0].targets.map((t) => path.basename(t.fsPath)).sort();
    expect(targets).toEqual(["proj", "top.txt"]);
    expect(compressCall[3]).toEqual([]); // no exclusions for extracted entries

    // Original archive replaced, no backup or work dir left behind.
    expect(fs.readFileSync(archivePath)).toEqual(RAR5_SIG);
    expect(fs.existsSync(`${archivePath}.rar5bak`)).toBe(false);
    expect(fs.readdirSync(dir).some((n) => n.startsWith(".sa-rar5-"))).toBe(false);
  });

  it("forwards the password to extract and re-compress", async () => {
    await rebuildRarArchive({
      archivePath,
      password: "secret",
      mutate: () => {},
    });
    expect(decompressWithSystem7z).toHaveBeenCalledWith(
      expect.objectContaining({ password: "secret" }),
      undefined,
      undefined,
    );
    expect(vi.mocked(compressWithRar5).mock.calls[0][0].password).toBe("secret");
  });

  it("asks before rebuilding a RAR4 archive (declined → aborts)", async () => {
    const old = fakeArchive(dir, "old.rar", RAR4_SIG);
    const spy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce(undefined);
    await expect(
      rebuildRarArchive({ archivePath: old, mutate: () => {} }),
    ).rejects.toThrow(/RAR4/);
    expect(spy).toHaveBeenCalledOnce();
    expect(decompressWithSystem7z).not.toHaveBeenCalled();
  });

  it("converts a RAR4 archive to RAR5 when confirmed", async () => {
    const old = fakeArchive(dir, "old.rar", RAR4_SIG);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce("Rebuild as RAR5");
    await rebuildRarArchive({ archivePath: old, mutate: () => {} });
    expect(decompressWithSystem7z).toHaveBeenCalledWith(
      expect.objectContaining({ inputPath: old }),
      undefined,
      undefined,
    );
    expect(vi.mocked(compressWithRar5).mock.calls[0][0].format.label).toBe("rar");
  });

  it("rejects an empty extraction", async () => {
    vi.mocked(decompressWithSystem7z).mockImplementation(async (opts) => {
      fs.mkdirSync(opts.outputDir, { recursive: true });
    });
    await expect(
      rebuildRarArchive({ archivePath, mutate: () => {} }),
    ).rejects.toThrow(/empty|为空/i);
  });
});

describe("copyIntoArchive", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5c-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("copies a file into the archive tree", () => {
    const src = path.join(dir, "file.txt");
    fs.writeFileSync(src, "data");
    const dest = path.join(dir, "archive");
    copyIntoArchive(dest, src, prepareExclusions([]));
    expect(fs.readFileSync(path.join(dest, "file.txt"), "utf8")).toBe("data");
  });

  it("copies directories while honoring exclusion patterns", () => {
    const src = path.join(dir, "addme");
    fs.mkdirSync(path.join(src, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(src, "keep.txt"), "keep");
    fs.writeFileSync(path.join(src, "node_modules", "pkg", "index.js"), "noise");
    const dest = path.join(dir, "archive");
    copyIntoArchive(dest, src, prepareExclusions(["node_modules"]));
    expect(fs.existsSync(path.join(dest, "addme", "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "addme", "node_modules"))).toBe(false);
  });
});
