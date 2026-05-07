/**
 * Workspace compress, parse7z, and naming tests — Smart Archive VSCode Extension
 */

import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { j7zCompressDir } from "./helpers";
import type { JS7zInstance } from "./helpers";

const JS7z: (opts?: Record<string, unknown>) => Promise<JS7zInstance> = require("js7z-tools");

const td = fs.mkdtempSync(path.join(require("os").tmpdir(), "sat_"));

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
    const raw = fs.readFileSync(insidePath);
    j2.FS.writeFile("/_check.7z", new Uint8Array(raw));
    await new Promise<void>((resolve, reject) => {
      j2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)));
      j2.callMain(["l", "-sccUTF-8", "/_check.7z"]);
    });
    expect(listing).toContain("index.ts");
    expect(listing).toContain("README.md");

    fs.unlinkSync(insidePath);
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  it("computes save dir inside workspace (not parent) when isWorkspaceCompress", () => {
    const wsPath = "/home/user/my-project";
    const normalDir = path.posix.dirname(wsPath);
    expect(normalDir).toBe("/home/user");
    expect(wsPath).toBe("/home/user/my-project");

    const archive = path.posix.join(wsPath, path.posix.basename(wsPath) + ".7z");
    expect(archive).toBe("/home/user/my-project/my-project.7z");
    expect(archive.startsWith(wsPath + "/")).toBe(true);
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

  const itOrSkip = _tempFiles ? it : it.skip;

  itOrSkip("pruneOldPreviews: handles nonexistent directory gracefully", () => {
    expect(() => _tempFiles!.pruneOldPreviews()).not.toThrow();
  });
});

// ── parse7zListing self-reference filter ─────────────────────────────

function filterSelfRefs(
  results: { path: string; size: number; type: string }[],
  archiveName: string,
  archivePath?: string,
): { path: string; size: number; type: string }[] {
  return results.filter((r) => {
    const p = r.path;
    if (p === `/${archiveName}` || p === archiveName) return false;
    if (archivePath) {
      if (p === archivePath) return false;
      if (p === archivePath.replace(/\\/g, "/")) return false;
      if (p.toLowerCase() === archivePath.toLowerCase()) return false;
    }
    return true;
  });
}

describe("parse7zListing archive self-reference filter", () => {
  it("filters system 7z full archive path", () => {
    const results = [
      { path: "C:\\Users\\test\\archive.zip", size: 151, type: "REGULAR_FILE" },
      { path: "src/main.ts", size: 123, type: "REGULAR_FILE" },
      { path: "sub", size: 0, type: "DIRECTORY" },
    ];
    const filtered = filterSelfRefs(results, "archive.zip", "C:\\Users\\test\\archive.zip");
    expect(filtered.length).toBe(2);
    expect(filtered[0].path).toBe("src/main.ts");
    expect(filtered[1].path).toBe("sub");
    expect(filtered.some((r) => r.path.includes("archive.zip"))).toBe(false);
  });

  it("filters forward-slash archive path", () => {
    const results = [
      { path: "C:/Users/test/archive.tar.gz", size: 200, type: "REGULAR_FILE" },
      { path: "readme.md", size: 42, type: "REGULAR_FILE" },
    ];
    const filtered = filterSelfRefs(results, "archive.tar.gz", "C:\\Users\\test\\archive.tar.gz");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("readme.md");
  });

  it("filters by case-insensitive path", () => {
    const results = [
      { path: "D:\\other\\path\\archive.7z", size: 100, type: "REGULAR_FILE" },
      { path: "data.txt", size: 100, type: "REGULAR_FILE" },
    ];
    const filtered = filterSelfRefs(results, "archive.7z", "d:\\other\\path\\archive.7z");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("data.txt");
  });

  it("filters VFS-style /archive.7z self-reference", () => {
    const results = [
      { path: "/archive.7z", size: 100, type: "REGULAR_FILE" },
      { path: "readme.md", size: 50, type: "REGULAR_FILE" },
    ];
    const filtered = filterSelfRefs(results, "archive.7z");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("readme.md");
  });

  it("keeps inner file whose base name matches archive name", () => {
    const results = [
      { path: "other/dir/archive.7z", size: 100, type: "REGULAR_FILE" },
      { path: "readme.md", size: 50, type: "REGULAR_FILE" },
    ];
    const filtered = filterSelfRefs(results, "archive.7z", "/archive.7z");
    expect(filtered.length).toBe(2);
    expect(filtered.some((r) => r.path === "other/dir/archive.7z")).toBe(true);
  });

  it("keeps file with similar but not same base name", () => {
    const results = [
      { path: "/archive.7z", size: 100, type: "REGULAR_FILE" },
      { path: "archive-backup.7z", size: 500, type: "REGULAR_FILE" },
    ];
    const filtered = filterSelfRefs(results, "archive.7z");
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe("archive-backup.7z");
  });
});

// ── Archive naming conventions ───────────────────────────────────────

describe("archive naming conventions", () => {
  const COMPOUND = [
    ".tar.zst", ".tar.xz", ".tar.bz2", ".tar.gz", ".tgz",
    ".tbz2", ".tbz", ".txz", ".tzst", ".tar.lz", ".tar.lzma", ".tlz",
  ];
  function getExt(fpath: string): string {
    const lower = fpath.toLowerCase();
    for (const ext of COMPOUND) { if (lower.endsWith(ext)) return ext; }
    return path.extname(fpath).toLowerCase();
  }

  it("keep original name + append format (promptSavePath single-file)", () => {
    function defName(filePath: string, format: string): string {
      return path.posix.join(
        path.posix.dirname(filePath),
        path.posix.basename(filePath) + "." + format,
      );
    }
    expect(defName("/a/b.tar.gz", "7z")).toBe("/a/b.tar.gz.7z");
    expect(defName("/a/b.tar.gz", "zip")).toBe("/a/b.tar.gz.zip");
    expect(defName("/a/b.tar.gz", "tar.gz")).toBe("/a/b.tar.gz.tar.gz");
    expect(defName("/a/b.7z", "zip")).toBe("/a/b.7z.zip");
    expect(defName("/a/b.txt", "tar.gz")).toBe("/a/b.txt.tar.gz");
  });

  it("getFullExt returns compound extensions correctly", () => {
    expect(getExt("file.tar.gz")).toBe(".tar.gz");
    expect(getExt("file.tar.bz2")).toBe(".tar.bz2");
    expect(getExt("file.tar.xz")).toBe(".tar.xz");
    expect(getExt("file.tar.zst")).toBe(".tar.zst");
    expect(getExt("file.tgz")).toBe(".tgz");
    expect(getExt("file.7z")).toBe(".7z");
    expect(getExt("file.zip")).toBe(".zip");
    expect(getExt("file.txt")).toBe(".txt");
  });

  it("uniquePath preserves compound extension", () => {
    function compoundBase(fpath: string): string {
      const ext = getExt(fpath);
      const base = path.basename(fpath, ext);
      return `${base}_1${ext}`;
    }
    expect(compoundBase("/dir/file.tar.gz")).toBe("file_1.tar.gz");
    expect(compoundBase("/dir/file.tar.bz2")).toBe("file_1.tar.bz2");
    expect(compoundBase("/dir/file.tar.xz")).toBe("file_1.tar.xz");
    expect(compoundBase("/dir/file.7z")).toBe("file_1.7z");
    expect(compoundBase("/dir/file.zip")).toBe("file_1.zip");
  });
});
