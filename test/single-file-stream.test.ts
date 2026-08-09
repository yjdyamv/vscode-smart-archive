/**
 * Single-file stream formats (gz/xz/bz2) vs wrapped tar formats.
 *
 * Streams must list as a single synthesized inner entry, preview, and
 * decompress to one file; tar.gz/tar.xz/tar.bz2 must keep their real tar
 * tree in list/decompress/preview without being confused with the streams.
 * Requires a system 7-Zip installation; skipped otherwise.
 */


import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import { fetchFileList } from "../src/providers/fileListing";
import { decompressWith7z } from "../src/engines/js7z-decompress";
import { previewFileFromArchive } from "../src/providers/archive/modify";
import { getPreviewTmpDir } from "../src/providers/tempFiles";
import { getPreviewCacheConfig, getPreviewCacheDir, initPreviewCache } from "../src/providers/previewCache";

function previewDir(): string {
  return getPreviewCacheDir() ?? getPreviewTmpDir();
}
import { beforeAll } from "vitest";
import { itIf } from "./gates";
import { __setWorkspaceFs } from "./__mocks__/vscode";
import { tmpDir } from "./tmp";

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

// Unencrypted previews now persist in the preview cache (globalStorage in
// production); point it at a test dir so the cache-hit tests can inspect it.
beforeAll(() => {
  initPreviewCache(tmpDir("sat_pvcache_"));
});


function stubVscodePreviewApis(archivePath: string): void {
  __setWorkspaceFs({
    stat: async () => ({ size: fs.statSync(archivePath).size }),
  });
}

describe("single-file streams", () => {
  for (const [ext, flag] of [
    ["gz", "gzip"],
    ["xz", "xz"],
    ["bz2", "bzip2"],
  ] as const) {
    itIf("system7z", `list + decompress .${ext}`, async () => {
      const td = tmpDir(`sat_str_${ext}_`);
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

    itIf("system7z", `preview .${ext} extracts the single inner file`, async () => {
      const td = tmpDir(`sat_strprev_${ext}_`);
      const src = path.join(td, "data.bin");
      fs.writeFileSync(src, "hello single-file stream\n".repeat(1000));
      const arc = path.join(td, `data.${ext}`);
      const r = spawnSync(sz!, ["a", `-t${flag}`, arc, src], { stdio: "pipe" });
      expect(r.status).toBe(0);

      const entries = await fetchFileList(arc);
      stubVscodePreviewApis(arc);
      const before = new Set(fs.readdirSync(previewDir()));
      await previewFileFromArchive(arc, entries[0].path);
      const created = fs.readdirSync(previewDir()).filter((f) => !before.has(f));
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
    itIf("system7z", `wrapped ${ext} lists tar entries, not a single stream entry`, async () => {
      const td = tmpDir("sat_wrap_");
      const arc = mkArchive(td, ext, flag);
      const entries = await fetchFileList(arc);
      expect(entries.length).toBeGreaterThan(1);
      expect(entries.some((e) => e.path.endsWith("a.txt"))).toBe(true);
      fs.rmSync(td, { recursive: true, force: true });
    });

    itIf("system7z", `wrapped ${ext} decompresses to the tar tree`, async () => {
      const td = tmpDir("sat_wrap2_");
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

    itIf("system7z", `wrapped ${ext} previews a file from inside the tar`, async () => {
      const td = tmpDir("sat_wrap3_");
      const arc = mkArchive(td, ext, flag);
      stubVscodePreviewApis(arc);
      const before = new Set(fs.readdirSync(previewDir()));
      await previewFileFromArchive(arc, "src/a.txt");
      const after = fs.readdirSync(previewDir());
      const created = after.filter((f) => !before.has(f));
      expect(created.length).toBeGreaterThan(0);
      fs.rmSync(td, { recursive: true, force: true });
    });
  }
});

describe("preview cache", () => {
  function buildArchive(td: string): { arc: string; entry: string } {
    const src = path.join(td, "data.bin");
    const arc = path.join(td, "data.7z");
    fs.writeFileSync(src, "content version one\n");
    const r = spawnSync(sz!, ["a", arc, src], { stdio: "pipe" });
    expect(r.status).toBe(0);
    stubVscodePreviewApis(arc);
    return { arc, entry: "data.bin" };
  }

  function createdInPreviewDir(before: Set<string>): string[] {
    return fs.readdirSync(previewDir()).filter((f) => !before.has(f));
  }

  itIf("system7z", "re-extracts after the archive changes (key includes mtime + size)", async () => {
    const td = tmpDir("sat_pvc_change_");
    try {
      const { arc, entry } = buildArchive(td);
      const before0 = new Set(fs.readdirSync(previewDir()));
      await previewFileFromArchive(arc, entry);
      const first = createdInPreviewDir(before0);
      expect(first.length).toBe(1);
      expect(fs.readFileSync(path.join(previewDir(), first[0]), "utf8")).toBe(
        "content version one\n",
      );

      // Rebuild the archive with different content — mtime and size change.
      const src = path.join(td, "data.bin");
      fs.writeFileSync(src, "content version two, longer\n");
      const r = spawnSync(sz!, ["a", arc, src], { stdio: "pipe" });
      expect(r.status).toBe(0);

      await previewFileFromArchive(arc, entry);
      const created = createdInPreviewDir(before0).filter((f) => !first.includes(f));
      expect(created.length).toBe(1);
      expect(fs.readFileSync(path.join(previewDir(), created[0]), "utf8")).toBe(
        "content version two, longer\n",
      );
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  itIf("system7z", "serves the cached file without touching the engine (hit)", async () => {
    const td = tmpDir("sat_pvc_hit_");
    try {
      const { arc, entry } = buildArchive(td);
      // Freeze the archive mtime at a whole-millisecond value first —
      // utimes can only SET whole milliseconds, so this makes the cache
      // key exactly reproducible after the restore below.
      const FROZEN = new Date(1_700_000_000_000);
      fs.utimesSync(arc, FROZEN, FROZEN);
      const before0 = new Set(fs.readdirSync(previewDir()));
      await previewFileFromArchive(arc, entry);
      const first = createdInPreviewDir(before0);
      expect(first.length).toBe(1);
      const cachedPath = path.join(previewDir(), first[0]);
      expect(fs.readFileSync(cachedPath, "utf8")).toBe("content version one\n");

      // Corrupt the archive with same-size garbage and restore the frozen
      // mtime — the cache key stays identical, so the preview must be
      // served from the cache. Extracting the garbage would fail instead.
      const st = fs.statSync(arc);
      fs.writeFileSync(arc, Buffer.alloc(st.size, 0x42));
      fs.utimesSync(arc, FROZEN, FROZEN);

      await expect(previewFileFromArchive(arc, entry)).resolves.toBeUndefined();
      expect(fs.existsSync(cachedPath)).toBe(true);
      expect(fs.readFileSync(cachedPath, "utf8")).toBe("content version one\n");
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  itIf("system7z", "re-extracts when only the archive mtime changes", async () => {
    const td = tmpDir("sat_pvc_mtime_");
    try {
      const { arc, entry } = buildArchive(td);
      await previewFileFromArchive(arc, entry);
      const before = new Set(fs.readdirSync(previewDir()));

      const st = fs.statSync(arc);
      fs.utimesSync(arc, new Date(st.mtimeMs + 5000), new Date(st.mtimeMs + 5000));

      await previewFileFromArchive(arc, entry);
      const created = createdInPreviewDir(before);
      expect(created.length).toBe(1);
      expect(fs.readFileSync(path.join(previewDir(), created[0]), "utf8")).toBe(
        "content version one\n",
      );
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

describe("wrapped preview fast path (7z auto-unpacks the inner tar)", () => {
  for (const ext of ["tar.gz", "tar.xz", "tar.bz2", "tar.zst"] as const) {
    itIf("system7z", `preview inside .${ext} uses system7z and the cache`, async () => {
      const td = tmpDir(`sat_pvf_${ext.replace(".", "_")}_`);
      try {
        const srcDir = path.join(td, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, "main.typ"), "inside " + ext + "\n".repeat(1000));
        const arc = path.join(td, `wrapped.${ext}`);
        const r = spawnSync(sz, ["a", "-ttar", arc, srcDir], { stdio: "pipe", timeout: 120_000 });
        expect(r.status).toBe(0);
        stubVscodePreviewApis(arc);

        const entries = (await fetchFileList(arc)).map((e) => e.path);
        const main = entries.find((e) => e.endsWith("main.typ"))!;
        const before = new Set(fs.readdirSync(previewDir()));

        // Cold: 7-Zip auto-unpacks the inner tar for these wraps — the old
        // code required an intermediate .tar and silently fell back to WASM
        // ("No inner tar found"). The fast path completes in ms.
        const t0 = Date.now();
        await previewFileFromArchive(arc, main);
        const cold = Date.now() - t0;
        const first = fs.readdirSync(previewDir()).filter((f) => !before.has(f));
        expect(first.length).toBe(1);
        const cachedPath = path.join(previewDir(), first[0]);
        expect(fs.readFileSync(cachedPath, "utf8")).toBe("inside " + ext + "\n".repeat(1000));
        const cachedMtime = fs.statSync(cachedPath).mtimeMs;
        expect(cold).toBeLessThan(100);

        // Warm: cache hit — same file untouched, no new files, and the hit
        // refreshes mtime (idle-TTL LRU: revisited entries keep their slot).
        const t1 = Date.now();
        await previewFileFromArchive(arc, main);
        const warm = Date.now() - t1;
        const createdAfter = fs
          .readdirSync(previewDir())
          .filter((f) => !before.has(f) && f !== first[0]);
        expect(fs.statSync(cachedPath).mtimeMs).toBeGreaterThanOrEqual(cachedMtime);
        expect(createdAfter.length).toBe(0);
        expect(warm).toBeLessThan(50);
      } finally {
        fs.rmSync(td, { recursive: true, force: true });
      }
    });
  }
});

describe("preview disk budget", () => {
  itIf(
    "system7z",
    "a large unencrypted preview never enters the persistent cache",
    async () => {
      const td = tmpDir("sat_bigprev_");
      try {
        const src = path.join(td, "big.bin");
        fs.writeFileSync(src, Buffer.alloc(getPreviewCacheConfig().maxCacheableBytes + 1024, 7));
        const arc = path.join(td, "big.7z");
        const r = spawnSync(sz!, ["a", arc, src], { stdio: "pipe" });
        expect(r.status).toBe(0);

        const entries = await fetchFileList(arc);
        stubVscodePreviewApis(arc);
        const cacheBefore = new Set(fs.readdirSync(getPreviewCacheDir()!));
        const tmpBefore = new Set(fs.readdirSync(getPreviewTmpDir()));

        // Cold preview: extracted to the session temp dir, NOT promoted.
        await previewFileFromArchive(arc, entries[0].path);
        const cacheCreated = fs
          .readdirSync(getPreviewCacheDir()!)
          .filter((f) => !cacheBefore.has(f));
        const tmpCreated = fs.readdirSync(getPreviewTmpDir()).filter((f) => !tmpBefore.has(f));
        expect(cacheCreated).toEqual([]);
        expect(tmpCreated.length).toBe(1);

        // Warm preview: still no cache file — large files are re-extracted
        // from the temp staging (which dies with the tab) rather than
        // occupying the cache for up to the idle-TTL.
        await previewFileFromArchive(arc, entries[0].path);
        const cacheCreated2 = fs
          .readdirSync(getPreviewCacheDir()!)
          .filter((f) => !cacheBefore.has(f));
        expect(cacheCreated2).toEqual([]);
      } finally {
        fs.rmSync(td, { recursive: true, force: true });
      }
    },
  );
});
