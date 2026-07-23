/**
 * Compress/Decompress engine tests — Smart Archive VSCode Extension
 *
 * Tests for: js7z compress/decompress (all formats), production pipeline
 * round-trips, wrapped format round-trips, stream-to-VFS large files,
 * and split volume creation/extraction.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  mkdirP,
  run7z,
  j7zCompress,
  j7zCompressDir,
  j7zDecompress,
  copyFS,
  buildTree,
  countTreeStats,
  isEncryptedInline,
  getFullExt,
  formatCompactSize,
  createWrapped,
  trackedJS7z,
  resetActiveInstances,
  disposeAllTracked,
  zstd,
  lz4Wasm,
  lz4Inited,
  setLz4Inited,
  lz4jsDec,
  brWasm,
  decompressBrotliFrames,
  decompressLz4Frames,
  sanitizeCliPath,
  sanitizeTargetDir,
  safeJoin,
  parseSize,
  disposeJS7z,
} from "./shared-setup";
import { testCompress, testDecompress } from "./test-helpers";
import type { JS7zInstance, FlatEntry } from "./shared-setup";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  resetActiveInstances();
});

afterEach(() => {
  disposeAllTracked();
});

const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_"));
describe("js7z compress/decompress", () => {

  // ── 7z ──

  it("7z single file", async () => {
    const b = await j7zCompress({ "/a.txt": "hello" }, "/x.7z");
    const f = await j7zDecompress(b);
    expect(f["a.txt"]).toBe("hello");
  });

  it("7z multi file", async () => {
    const b = await j7zCompressDir({ "/s/1.txt": "1", "/s/2.txt": "2", "/s/3.txt": "3" }, "/m.7z");
    const f = await j7zDecompress(b);
    expect(Object.keys(f).length).toBe(3);
    expect(f["s/1.txt"]).toBe("1");
  });

  it("7z nested folder", async () => {
    const b = await j7zCompressDir(
      { "/p/readme.md": "#P", "/p/src/main.js": "log(1)", "/p/src/lib/x.js": "exports=1" },
      "/d.7z",
    );
    const f = await j7zDecompress(b);
    expect(Object.keys(f).length).toBe(3);
    expect(f["p/readme.md"]).toBe("#P");
    expect(f["p/src/lib/x.js"]).toBe("exports=1");
  });

  it("7z encrypted -mhe=on", async () => {
    const b = await j7zCompress({ "/s.txt": "sec" }, "/e.7z", ["-ppw", "-mhe=on"]);
    await expect(j7zDecompress(b, "bad")).rejects.toThrow(/7z exit/);
    const f = await j7zDecompress(b, "pw");
    expect(f["s.txt"]).toBe("sec");
  });

  it("7z encrypted no -mhe", async () => {
    const b = await j7zCompress({ "/s.txt": "sec" }, "/e2.7z", ["-ppw"]);
    const f = await j7zDecompress(b, "pw");
    expect(f["s.txt"]).toBe("sec");
  });

  // ── ZIP ──

  it("ZIP single", async () => {
    const b = await j7zCompress({ "/d.txt": "zip" }, "/z.zip");
    const f = await j7zDecompress(b);
    expect(f["d.txt"]).toBe("zip");
  });

  it("ZIP multi", async () => {
    const b = await j7zCompressDir({ "/a/a.txt": "A", "/a/b.txt": "B" }, "/zm.zip");
    const f = await j7zDecompress(b);
    expect(f["a/a.txt"]).toBe("A");
    expect(f["a/b.txt"]).toBe("B");
  });

  it("ZIP nested folder", async () => {
    const b = await j7zCompressDir(
      { "/app/index.html": "<h>", "/app/js/main.js": "var x" },
      "/zf.zip",
    );
    const f = await j7zDecompress(b);
    expect(f["app/index.html"]).toBe("<h>");
    expect(f["app/js/main.js"]).toBe("var x");
  });

  it("ZIP encrypted", async () => {
    const b = await j7zCompress({ "/e.txt": "locked" }, "/ez.zip", ["-ppw"]);
    await expect(j7zDecompress(b, "bad")).rejects.toThrow(/7z exit/);
    const f = await j7zDecompress(b, "pw");
    expect(f["e.txt"]).toBe("locked");
  });

  // ── TAR ──

  it("TAR single", async () => {
    const b = await j7zCompress({ "/n.txt": "tar" }, "/t.tar");
    const f = await j7zDecompress(b);
    expect(f["n.txt"]).toBe("tar");
  });

  it("TAR multi", async () => {
    const b = await j7zCompressDir({ "/x/a.txt": "a", "/x/b.txt": "b" }, "/tm.tar");
    const f = await j7zDecompress(b);
    expect(f["x/a.txt"]).toBe("a");
    expect(f["x/b.txt"]).toBe("b");
  });

  // ── Stream formats ──

  it("GZip stream", async () => {
    const b = await j7zCompress({ "/log.txt": "gzip" }, "/l.gz");
    expect(b.length).toBeLessThan(80);
    const f = await j7zDecompress(b);
    expect(Object.values(f).length).toBeGreaterThanOrEqual(1);
  });

  it("BZip2 stream", async () => {
    const b = await j7zCompress({ "/d.bin": "bz2" }, "/d.bz2");
    expect(b.length).toBeGreaterThan(0);
    const f = await j7zDecompress(b);
    expect(Object.values(f).length).toBeGreaterThanOrEqual(1);
  });

  it("XZ stream", async () => {
    const b = await j7zCompress({ "/c.yml": "xz" }, "/c.xz");
    expect(b.length).toBeGreaterThan(0);
    const f = await j7zDecompress(b);
    expect(Object.values(f).length).toBeGreaterThanOrEqual(1);
  });

  // ── WIM ──

  it("WIM create + extract", async () => {
    const j = await trackedJS7z();
    j.FS.mkdir("/src");
    j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
    await run7z(j, ["a", "-twim", "/tw.wim", "/src"]);
    const buf = Buffer.from(j.FS.readFile("/tw.wim", { encoding: "binary" }));
    const f = await j7zDecompress(buf);
    expect(f["src/a.txt"]).toBe("wim");
  });
});

// ════════════════════════════════════════════════════════════════════
// Production pipeline round-trips (testCompress → compressWith7z)
//
// These tests call the REAL production functions instead of
// constructing raw 7z CLI arguments.  They exercise format
// dispatching, -xr! flag generation, toBinaryVolumeSize,
// validatePassword, createTarFile, and codec compression.
// ════════════════════════════════════════════════════════════════════


describe("production pipeline round-trips", () => {

  // ── 7z ──

  it("7z single file", async () => {
    const b = await testCompress({ "a.txt": "hello" }, "7z");
    const f = await testDecompress(b);
    expect(f["a.txt"]).toBe("hello");
  });

  it("7z multi file", async () => {
    const b = await testCompress(
      { "s/1.txt": "1", "s/2.txt": "2", "s/3.txt": "3" },
      "7z",
    );
    const f = await testDecompress(b);
    expect(Object.keys(f).length).toBe(3);
    expect(f["s/1.txt"]).toBe("1");
  });

  it("7z nested folder", async () => {
    const b = await testCompress(
      { "p/readme.md": "#P", "p/src/main.js": "log(1)", "p/src/lib/x.js": "exports=1" },
      "7z",
    );
    const f = await testDecompress(b);
    expect(Object.keys(f).length).toBe(3);
    expect(f["p/readme.md"]).toBe("#P");
    expect(f["p/src/lib/x.js"]).toBe("exports=1");
  });

  it("7z encrypted (production auto-adds -mhe=on)", async () => {
    const b = await testCompress({ "s.txt": "sec" }, "7z", { password: "pw" });
    // Wrong password should fail
    await expect(testDecompress(b, { password: "bad" })).rejects.toThrow();
    // Correct password should work
    const f = await testDecompress(b, { password: "pw" });
    expect(f["s.txt"]).toBe("sec");
  });

  // ── ZIP ──

  it("ZIP single", async () => {
    const b = await testCompress({ "d.txt": "zip" }, "zip");
    const f = await testDecompress(b, { ext: "zip" });
    expect(f["d.txt"]).toBe("zip");
  });

  it("ZIP multi", async () => {
    const b = await testCompress({ "a/a.txt": "A", "a/b.txt": "B" }, "zip");
    const f = await testDecompress(b, { ext: "zip" });
    expect(f["a/a.txt"]).toBe("A");
    expect(f["a/b.txt"]).toBe("B");
  });

  it("ZIP nested folder", async () => {
    const b = await testCompress(
      { "app/index.html": "<h>", "app/js/main.js": "var x" },
      "zip",
    );
    const f = await testDecompress(b, { ext: "zip" });
    expect(f["app/index.html"]).toBe("<h>");
    expect(f["app/js/main.js"]).toBe("var x");
  });

  it("ZIP encrypted", async () => {
    const b = await testCompress({ "e.txt": "locked" }, "zip", { password: "pw" });
    await expect(testDecompress(b, { password: "bad", ext: "zip" })).rejects.toThrow();
    const f = await testDecompress(b, { password: "pw", ext: "zip" });
    expect(f["e.txt"]).toBe("locked");
  });

  // ── TAR ──

  it("TAR single", async () => {
    const b = await testCompress({ "n.txt": "tar" }, "tar");
    const f = await testDecompress(b, { ext: "tar" });
    expect(f["n.txt"]).toBe("tar");
  });

  it("TAR multi", async () => {
    const b = await testCompress({ "x/a.txt": "a", "x/b.txt": "b" }, "tar");
    const f = await testDecompress(b, { ext: "tar" });
    expect(f["x/a.txt"]).toBe("a");
    expect(f["x/b.txt"]).toBe("b");
  });

  // ── WIM ──

  it("WIM round-trip", async () => {
    const b = await testCompress({ "src/a.txt": "wim" }, "wim");
    const f = await testDecompress(b, { ext: "wim" });
    expect(f["src/a.txt"]).toBe("wim");
  });

  // ── Wrapped formats (tar.gz / tar.bz2 / tar.xz) ──
  // NOTE: Wrapped format decompression via system 7z only unwraps one layer
  // (produces .tar, not final files). These round-trip tests work only with
  // the WASM path. Covered separately by the existing createWrapped tests.
  // TODO: fix system 7z decompression to auto-unwrap inner tar
});

// ════════════════════════════════════════════════════════════════════
// Exclusion integration tests (compression WITH exclude patterns)
//
// These verify that exclude patterns actually work through the full
// production pipeline. Isolation tests for exclude.ts are below;
// these test the INTEGRATION with compressWith7z.
// ════════════════════════════════════════════════════════════════════


describe("wrapped format round-trips", () => {
  for (const ext of ["tar.gz", "tar.bz2", "tar.xz"] as const) {
    it(`${ext} round-trip`, async () => {
      const files = { "/d/a.txt": "hello", "/d/b.txt": "world", "/e/c.txt": "nested" };
      const j = await trackedJS7z();
      try {
        for (const [fp, content] of Object.entries(files)) {
          mkdirP(j, path.posix.dirname(fp));
          j.FS.writeFile(fp, new Uint8Array(Buffer.from(content)));
        }
        const tops = [...new Set(Object.keys(files).map((f) => "/" + f.split("/")[1]))];

        await run7z(j, ["a", "/_t.tar", ...tops]);
        const tarBuf = Buffer.from(j.FS.readFile("/_t.tar", { encoding: "binary" }));

        const j2 = await trackedJS7z();
        try {
          j2.FS.writeFile("/_t.tar", new Uint8Array(tarBuf));
          await run7z(j2, ["a", "/_w." + ext, "/_t.tar"]);

          const compBuf = Buffer.from(j2.FS.readFile("/_w." + ext, { encoding: "binary" }));
          const j3 = await trackedJS7z();
          try {
            j3.FS.writeFile("/a." + ext, new Uint8Array(compBuf));
            j3.FS.mkdir("/o1");
            await run7z(j3, ["x", "/a." + ext, "-o/o1", "-y"]);

            const top = j3.FS.readdir("/o1").filter((e: string) => e !== "." && e !== "..");
            if (top.length === 0) throw new Error(ext + ": no files after outer decompress");
            const innerTar = top[0];
            const innerData = j3.FS.readFile("/o1/" + innerTar, { encoding: "binary" });

            const j4 = await trackedJS7z();
            try {
              j4.FS.writeFile("/_inner.tar", new Uint8Array(innerData));
              j4.FS.mkdir("/o2");
              await run7z(j4, ["x", "/_inner.tar", "-o/o2", "-y"]);

              const result: Record<string, string> = {};
              copyFS(j4, "/o2", "", result);
              expect(result["d/a.txt"]).toBe("hello");
              expect(result["d/b.txt"]).toBe("world");
              expect(result["e/c.txt"]).toBe("nested");
            } finally {
              disposeJS7z(j4);
            }
          } finally {
            disposeJS7z(j3);
          }
        } finally {
          disposeJS7z(j2);
        }
      } finally {
        disposeJS7z(j);
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// Stream-to-VFS for large files
// ════════════════════════════════════════════════════════════════════


describe("stream-to-VFS large files", () => {
  it("7z round-trip with dirs", async () => {
    const root = path.join(td, "src");
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "readme.md"), "A".repeat(50 * 1024 * 1024));
    fs.writeFileSync(path.join(root, "lib", "util.js"), "B".repeat(30 * 1024 * 1024));
    fs.writeFileSync(path.join(root, "bin", "app.exe"), "C".repeat(20 * 1024 * 1024));

    const j = await trackedJS7z();
    function streamDir(localDir: string, vfsDir: string, _token?: unknown) {
      const entries = fs.readdirSync(localDir, { withFileTypes: true });
      for (const e of entries) {
        const loc = path.join(localDir, e.name);
        const vfs = `${vfsDir}/${e.name}`;
        if (e.isDirectory()) {
          j.FS.mkdir(vfs);
          streamDir(loc, vfs);
        } else {
          const rfd = fs.openSync(loc, "r");
          j.FS.createDataFile("/", vfs.replace(/^\//, ""), new Uint8Array(0), true, true, 0o777);
          const stream = j.FS.open(vfs, "w");
          const chunk = Buffer.alloc(10 * 1024 * 1024);
          let pos = 0;
          while (true) {
            const n = fs.readSync(rfd, chunk, 0, chunk.length, pos);
            if (n === 0) break;
            j.FS.write(stream, new Uint8Array(chunk.slice(0, n)), 0, n, pos);
            pos += n;
          }
          j.FS.close(stream);
          fs.closeSync(rfd);
        }
      }
    }
    j.FS.mkdir("/src");
    streamDir(root, "/src");

    await run7z(j, ["a", "/out.7z", "/src", "-mx1"]);
    const outBuf = Buffer.from(j.FS.readFile("/out.7z", { encoding: "binary" }));
    const f = await j7zDecompress(outBuf);

    expect(f["src/readme.md"].length).toBe(50 * 1024 * 1024);
    expect(f["src/lib/util.js"].length).toBe(30 * 1024 * 1024);
    expect(f["src/bin/app.exe"].length).toBe(20 * 1024 * 1024);
  });
});

// ════════════════════════════════════════════════════════════════════
// Split volumes
// ════════════════════════════════════════════════════════════════════


describe("split volumes", () => {
  it("7z round-trip", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("hello")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/x.7z", "/a.txt", "/b.txt", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("x.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(1);

    const j2 = await trackedJS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/x.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["a.txt"]).toBe("hello");
    expect(res["b.txt"]).toBe("world");
  });

  it("zip round-trip", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("hello")));
    j.FS.writeFile("/b.txt", new Uint8Array(Buffer.from("world")));
    await run7z(j, ["a", "/x.zip", "/a.txt", "/b.txt", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("x.zip."));
    expect(parts.length).toBeGreaterThanOrEqual(1);

    const j2 = await trackedJS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/x.zip.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["a.txt"]).toBe("hello");
    expect(res["b.txt"]).toBe("world");
  });

  it("multi-part 7z forces multiple parts", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/y.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("y.7z."));
    const count = parts.length;
    expect(count).toBeGreaterThanOrEqual(2);

    const j2 = await trackedJS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/y.7z.001", "-o/o"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["big.txt"].length).toBe(16384);
    expect(res["big.txt"]).toBe("x".repeat(16384));
  });

  it("encrypted 7z round-trip", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/a.txt", new Uint8Array(Buffer.from("secret")));
    await run7z(j, ["a", "/s.7z", "/a.txt", "-pp4ss", "-mhe=on", "-v10m"]);

    const parts = j.FS.readdir("/").filter((e) => e.startsWith("s.7z."));
    expect(parts.length).toBeGreaterThanOrEqual(1);

    const j2 = await trackedJS7z();
    for (const p of parts) {
      const data = j.FS.readFile("/" + p, { encoding: "binary" });
      j2.FS.writeFile("/" + p, new Uint8Array(data));
    }
    j2.FS.mkdir("/o");
    await run7z(j2, ["x", "/s.7z.001", "-o/o", "-pp4ss"]);
    const res: Record<string, string> = {};
    copyFS(j2, "/o", "", res);
    expect(res["a.txt"]).toBe("secret");
  });

  it("missing middle part throws error", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/x.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/")
      .filter((e: string) => e.startsWith("x.7z."))
      .sort();
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const j2 = await trackedJS7z();
    const first = parts[0];
    j2.FS.writeFile("/" + first, new Uint8Array(j.FS.readFile("/" + first, { encoding: "binary" })));

    if (parts.length > 2) {
      const last = parts[parts.length - 1];
      j2.FS.writeFile("/" + last, new Uint8Array(j.FS.readFile("/" + last, { encoding: "binary" })));
    }

    let stderr = "";
    let exitCode = 0;
    j2.printErr = (text: string) => {
      stderr += text + "\n";
    };
    await new Promise<void>((resolve) => {
      j2.onExit = (c: number) => {
        exitCode = c;
        resolve();
      };
      j2.callMain(["l", "-slt", "/" + first]);
    });

    expect(exitCode !== 0 || /error|missing|can.*open|unexpected/i.test(stderr)).toBe(true);
  });

  it("readdir skips gaps when parts deleted", async () => {
    const j = await trackedJS7z();
    j.FS.writeFile("/big.txt", new Uint8Array(Buffer.from("x".repeat(16384))));
    await run7z(j, ["a", "/x.7z", "/big.txt", "-v100b"]);

    const parts = j.FS.readdir("/")
      .filter((e: string) => e.startsWith("x.7z."))
      .sort();
    expect(parts.length).toBeGreaterThanOrEqual(2);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa_test_"));
    try {
      for (const p of parts) {
        const data = j.FS.readFile("/" + p, { encoding: "binary" });
        fs.writeFileSync(path.join(tmpDir, p), Buffer.from(data));
      }

      const toDelete = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
      fs.unlinkSync(path.join(tmpDir, toDelete));

      const j2 = await trackedJS7z();
      const name = "x.7z";
      const diskParts = fs
        .readdirSync(tmpDir)
        .filter((f: string) =>
          new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`).test(f),
        )
        .sort();

      for (const dp of diskParts) {
        const diskPath = path.join(tmpDir, dp);
        const data = fs.readFileSync(diskPath);
        j2.FS.writeFile("/" + dp, new Uint8Array(data));
      }

      expect(diskParts.includes(toDelete)).toBe(false);
      expect(diskParts.includes(parts[0])).toBe(true);
      if (parts.length > 2) {
        expect(diskParts.includes(parts[parts.length - 1])).toBe(true);
      }

      let stderr = "";
      let exitCode = 0;
      j2.printErr = (text: string) => {
        stderr += text + "\n";
      };
      await new Promise<void>((resolve) => {
        j2.onExit = (c: number) => {
          exitCode = c;
          resolve();
        };
        j2.callMain(["l", "-slt", "/" + parts[0]]);
      });

      expect(exitCode !== 0 || /error|missing|can.*open|unexpected/i.test(stderr)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// Format conversion
// ════════════════════════════════════════════════════════════════════

