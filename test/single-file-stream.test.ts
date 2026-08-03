/**
 * Single-file stream formats (gz/xz/bz2) vs wrapped tar formats.
 *
 * Streams must list as a single synthesized inner entry, preview, and
 * decompress to one file; tar.gz/tar.xz/tar.bz2 must keep their real tar
 * tree in list/decompress/preview without being confused with the streams.
 * Requires a system 7-Zip installation; skipped otherwise.
 */

import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import { fetchFileList } from "../src/providers/fileListing";
import { decompressWith7z } from "../src/engines/js7z-decompress";
import { previewFileFromArchive } from "../src/providers/archive/modify";
import { getPreviewTmpDir } from "../src/providers/tempFiles";
import * as vscode from "vscode";

function find7z(): string | null {
  for (const c of ["/usr/bin/7z", "/usr/local/bin/7z", "7z", "7zz"]) {
    try {
      const r = spawnSync(c, [], { stdio: "pipe", timeout: 5000 });
      if (r.status === 0) return c;
    } catch {
      continue;
    }
  }
  return null;
}

const sz = find7z();
const itOrSkip = sz ? it : it.skip;

function stubVscodePreviewApis(archivePath: string): void {
  (vscode.workspace as unknown as { fs: unknown }).fs = {
    stat: async () => ({ size: fs.statSync(archivePath).size }),
  };
  (vscode.workspace as unknown as { onDidCloseTextDocument: unknown }).onDidCloseTextDocument =
    () => ({ dispose: () => {} });
  (vscode as unknown as { commands: unknown }).commands = {
    executeCommand: async () => undefined,
  };
  (vscode as unknown as { ViewColumn: unknown }).ViewColumn = { Beside: 2 };
}

describe("single-file streams", () => {
  for (const [ext, flag] of [
    ["gz", "gzip"],
    ["xz", "xz"],
    ["bz2", "bzip2"],
  ] as const) {
    itOrSkip(`list + decompress .${ext}`, async () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), `sat_str_${ext}_`));
      const src = path.join(td, "data.bin");
      fs.writeFileSync(src, "hello single-file stream\n".repeat(1000));
      const arc = path.join(td, `data.${ext}`);
      const r = spawnSync(sz!, ["a", `-t${flag}`, arc, src], { stdio: "pipe" });
      expect(r.status).toBe(0);

      const entries = await fetchFileList(arc);
      expect(entries.length).toBeGreaterThan(0);

      const outDir = path.join(td, "out");
      fs.mkdirSync(outDir);
      await decompressWith7z(
        { inputPath: arc, outputDir: outDir, password: "" },
        undefined,
        undefined,
      );

      const innerName = entries[0].path;
      const outFile = path.join(outDir, innerName);
      expect(fs.existsSync(outFile)).toBe(true);
      expect(fs.readFileSync(outFile, "utf8")).toBe("hello single-file stream\n".repeat(1000));
      fs.rmSync(td, { recursive: true, force: true });
    });

    itOrSkip(`preview .${ext} extracts the single inner file`, async () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), `sat_strprev_${ext}_`));
      const src = path.join(td, "data.bin");
      fs.writeFileSync(src, "hello single-file stream\n".repeat(1000));
      const arc = path.join(td, `data.${ext}`);
      const r = spawnSync(sz!, ["a", `-t${flag}`, arc, src], { stdio: "pipe" });
      expect(r.status).toBe(0);

      const entries = await fetchFileList(arc);
      stubVscodePreviewApis(arc);
      const before = new Set(fs.readdirSync(getPreviewTmpDir()));
      await previewFileFromArchive(arc, entries[0].path);
      const created = fs.readdirSync(getPreviewTmpDir()).filter((f) => !before.has(f));
      expect(created.length).toBeGreaterThan(0);
      fs.rmSync(td, { recursive: true, force: true });
    });
  }
});

describe("wrapped vs stream confusion", () => {
  const mkArchive = (td: string, ext: string, flag: string): string => {
    const srcDir = path.join(td, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "a.txt"), "AAA");
    fs.writeFileSync(path.join(srcDir, "b.txt"), "BBB");
    const tarPath = path.join(td, "bundle.tar");
    expect(spawnSync(sz!, ["a", "-ttar", tarPath, srcDir], { stdio: "pipe" }).status).toBe(0);
    const arc = path.join(td, `bundle${ext}`);
    const r = spawnSync(sz!, ["a", `-t${flag}`, arc, tarPath], { stdio: "pipe" });
    expect(r.status).toBe(0);
    return arc;
  };

  for (const [ext, flag] of [
    [".tar.gz", "gzip"],
    [".tar.xz", "xz"],
    [".tar.bz2", "bzip2"],
  ] as const) {
    itOrSkip(`wrapped ${ext} lists tar entries, not a single stream entry`, async () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_wrap_"));
      const arc = mkArchive(td, ext, flag);
      const entries = await fetchFileList(arc);
      expect(entries.length).toBeGreaterThan(1);
      expect(entries.some((e) => e.path.endsWith("a.txt"))).toBe(true);
      fs.rmSync(td, { recursive: true, force: true });
    });

    itOrSkip(`wrapped ${ext} decompresses to the tar tree`, async () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_wrap2_"));
      const arc = mkArchive(td, ext, flag);
      const outDir = path.join(td, "out");
      fs.mkdirSync(outDir);
      await decompressWith7z(
        { inputPath: arc, outputDir: outDir, password: "" },
        undefined,
        undefined,
      );
      const files: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(outDir);
      expect(files.some((f) => f.endsWith("a.txt"))).toBe(true);
      fs.rmSync(td, { recursive: true, force: true });
    });

    itOrSkip(`wrapped ${ext} previews a file from inside the tar`, async () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_wrap3_"));
      const arc = mkArchive(td, ext, flag);
      stubVscodePreviewApis(arc);
      const before = new Set(fs.readdirSync(getPreviewTmpDir()));
      await previewFileFromArchive(arc, "src/a.txt");
      const after = fs.readdirSync(getPreviewTmpDir());
      const created = after.filter((f) => !before.has(f));
      expect(created.length).toBeGreaterThan(0);
      fs.rmSync(td, { recursive: true, force: true });
    });
  }
});
