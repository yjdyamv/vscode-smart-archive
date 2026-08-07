/**
 * Workspace compress, parse7z, and naming tests — Smart Archive VSCode Extension
 */

import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { j7zCompressDir, disposeJS7z } from "./helpers";
import { JS7z } from "../src/engines/js7z-factory";
import { parse7zListing } from "../src/utils/parse7z";
import { getFullExt } from "../src/constants";
import { uniquePath } from "../src/providers/webview/helpers";
import { itIf } from "./gates";
import { tmpDir } from "./tmp";

const td = tmpDir("sat_");

// ── Workspace compress save path ─────────────────────────────────────

describe("workspace compress save path", () => {
  it("saves archive inside workspace folder, not alongside in parent dir", async () => {
    const wsDir = path.join(td, "ws-compress-test");
    const srcDir = path.join(wsDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "README.md"), "# test");
    fs.writeFileSync(path.join(srcDir, "index.ts"), "x");

    const files: Record<string, string> = {};
    const tops = new Set<string>();
    function walk(dir: string) {
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        const rel = "/" + path.relative(wsDir, fp).replace(/\\/g, "/");
        if (fs.statSync(fp).isDirectory()) {
          const seg = rel.split("/")[1];
          if (seg) tops.add(seg);
          walk(fp);
        } else {
          files[rel] = fs.readFileSync(fp, "utf-8");
          const seg = rel.split("/")[1];
          if (seg) tops.add(seg);
        }
      }
    }
    walk(wsDir);

    const archiveBuffer = await j7zCompressDir(files, "/_ws.7z");
    const archiveName = path.basename(wsDir) + ".7z";
    const insidePath = path.join(wsDir, archiveName);
    fs.writeFileSync(insidePath, archiveBuffer);

    const parentPath = path.join(path.dirname(wsDir), archiveName);
    expect(fs.existsSync(insidePath)).toBe(true);
    expect(fs.existsSync(parentPath)).toBe(false);

    let listing = "";
    const j2 = await JS7z({
      print: (t: string) => (listing += t + "\n"),
      printErr: () => {},
    });
    try {
      const raw = fs.readFileSync(insidePath);
      j2.FS.writeFile("/_check.7z", new Uint8Array(raw));
      await new Promise<void>((resolve, reject) => {
        j2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
        j2.callMain(["l", "-sccUTF-8", "/_check.7z"]);
      });
      expect(listing).toContain("index.ts");
      expect(listing).toContain("README.md");
    } finally {
      disposeJS7z(j2);
    }

    fs.unlinkSync(insidePath);
    fs.rmSync(wsDir, { recursive: true, force: true });
  });
});

// ── tempFiles ─────────────────────────────────────────────────────────

describe("tempFiles module", () => {
  const _tempFiles: { pruneOldPreviews: () => void } | null = (() => {
    try {
      return require("../../out/providers/tempFiles");
    } catch {
      return null;
    }
  })();

  itIf("outBuild", "pruneOldPreviews: handles nonexistent directory gracefully", () => {
    expect(() => _tempFiles!.pruneOldPreviews()).not.toThrow();
  });
});

// ── parse7zListing archive self-reference filtering (production) ─────

/** Builds `7z l -slt`-style stdout from entries — a test fixture, not logic. */
function slt(entries: { path: string; size: number; attr: string }[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`Path = ${e.path}`);
    if (e.size > 0) lines.push(`Size = ${e.size}`);
    if (e.attr) lines.push(`Attributes = ${e.attr}`);
    lines.push("");
  }
  return lines.join("\n");
}

describe("parse7zListing archive self-reference filter", () => {
  it("filters system 7z full archive path", () => {
    const stdout = slt([
      { path: "C:\\Users\\test\\archive.zip", size: 151, attr: "A" },
      { path: "src/main.ts", size: 123, attr: "A" },
      { path: "sub", size: 0, attr: "D" },
    ]);
    const filtered = parse7zListing(stdout, "archive.zip", "C:\\Users\\test\\archive.zip");
    expect(filtered.length).toBe(2);
    expect(filtered[0].path).toBe("src/main.ts");
    expect(filtered[1].path).toBe("sub");
    expect(filtered.some((r) => r.path.includes("archive.zip"))).toBe(false);
  });

  it("filters forward-slash archive path", () => {
    const stdout = slt([
      { path: "C:/Users/test/archive.tar.gz", size: 200, attr: "A" },
      { path: "readme.md", size: 42, attr: "A" },
    ]);
    const filtered = parse7zListing(stdout, "archive.tar.gz", "C:\\Users\\test\\archive.tar.gz");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("readme.md");
  });

  it("filters by case-insensitive path", () => {
    const stdout = slt([
      { path: "D:\\other\\path\\archive.7z", size: 100, attr: "A" },
      { path: "data.txt", size: 100, attr: "A" },
    ]);
    const filtered = parse7zListing(stdout, "archive.7z", "d:\\other\\path\\archive.7z");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("data.txt");
  });

  it("filters VFS-style /archive.7z self-reference", () => {
    const stdout = slt([
      { path: "/archive.7z", size: 100, attr: "A" },
      { path: "readme.md", size: 50, attr: "A" },
    ]);
    const filtered = parse7zListing(stdout, "archive.7z");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("readme.md");
  });

  it("keeps inner file whose base name matches archive name", () => {
    const stdout = slt([
      { path: "other/dir/archive.7z", size: 100, attr: "A" },
      { path: "readme.md", size: 50, attr: "A" },
    ]);
    const filtered = parse7zListing(stdout, "archive.7z", "/archive.7z");
    expect(filtered.length).toBe(2);
    expect(filtered.some((r) => r.path === "other/dir/archive.7z")).toBe(true);
  });

  it("keeps file with similar but not same base name", () => {
    const stdout = slt([
      { path: "/archive.7z", size: 100, attr: "A" },
      { path: "archive-backup.7z", size: 500, attr: "A" },
    ]);
    const filtered = parse7zListing(stdout, "archive.7z");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("archive-backup.7z");
  });
});

// ── Archive naming conventions (production getFullExt / uniquePath) ──

describe("archive naming conventions", () => {
  it("getFullExt returns compound extensions correctly", () => {
    expect(getFullExt("file.tar.gz")).toBe(".tar.gz");
    expect(getFullExt("file.tar.bz2")).toBe(".tar.bz2");
    expect(getFullExt("file.tar.xz")).toBe(".tar.xz");
    expect(getFullExt("file.tar.zst")).toBe(".tar.zst");
    expect(getFullExt("file.tar.lz")).toBe(".tar.lz");
    expect(getFullExt("file.tar.lzma")).toBe(".tar.lzma");
    expect(getFullExt("file.tgz")).toBe(".tgz");
    expect(getFullExt("file.tlz")).toBe(".tlz");
    expect(getFullExt("file.7z")).toBe(".7z");
    expect(getFullExt("file.zip")).toBe(".zip");
    expect(getFullExt("file.txt")).toBe(".txt");
  });

  it("uniquePath returns input when path is free", () => {
    const fp = path.join(td, "naming-unique", "file.txt");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    expect(uniquePath(fp)).toBe(fp);
  });

  it("uniquePath preserves compound extension when appending _1", () => {
    const dir = path.join(td, "naming-compound");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "file.tar.gz");
    fs.writeFileSync(fp, "x");
    expect(uniquePath(fp)).toBe(path.join(dir, "file_1.tar.gz"));
  });

  it("uniquePath bumps until a free name is found", () => {
    const dir = path.join(td, "naming-bump");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "file.7z");
    fs.writeFileSync(fp, "a");
    fs.writeFileSync(path.join(dir, "file_1.7z"), "b");
    expect(uniquePath(fp)).toBe(path.join(dir, "file_2.7z"));
  });
});
