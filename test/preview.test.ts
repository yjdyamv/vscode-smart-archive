/**
 * Preview tests — Smart Archive VSCode Extension
 *
 * Tests for: selective extraction (all formats), parse7zListing,
 * markNoisyDirs, two-step wrapped format extraction, zstd round-trip.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";

import {
  mkdirP,
  run7z,
  j7zCompress,
  j7zCompressDir,
  j7zSelective,
  createWrapped,
  walkFS,
  disposeJS7z,
} from "./helpers";
import type { FlatEntry } from "../src/providers/treeBuilder";
import { buildTree } from "../src/providers/treeBuilder";
import { markNoisyDirs } from "../src/utils/noisy-patterns";
import { parse7zListing } from "../src/utils/parse7z";
import { getFormatByExt, getFullExt, getWrapExtension, isWrappedFormat } from "../src/constants";
import { brotliCompressFile, brotliDecompressFile, brotliCompress, brotliDecompress } from "../src/engines/brotli-codec";
import { JS7z } from "../src/engines/js7z-factory";
import { wasmCompress, wasmDecompress } from "../src/engines/js7z-codec";
import { tmpDir } from "./tmp";


// ── Format matrix (mirrors FORMAT_TABLE from constants.ts) ──

interface Fmt {
  ext: string;
  wraps: boolean;
  j7z: boolean;
  short: string[];
}

const FM: Fmt[] = [
  { ext: "7z", wraps: false, j7z: true, short: [] },
  { ext: "zip", wraps: false, j7z: true, short: [] },
  { ext: "tar", wraps: false, j7z: true, short: [] },
  { ext: "tar.gz", wraps: true, j7z: false, short: ["tgz"] },
  { ext: "tar.bz2", wraps: true, j7z: false, short: ["tbz2", "tbz"] },
  { ext: "tar.xz", wraps: true, j7z: false, short: ["txz"] },
  { ext: "tar.zst", wraps: true, j7z: false, short: ["tzst"] },
  { ext: "tar.lz", wraps: true, j7z: false, short: ["tlz"] },
  { ext: "tar.lzma", wraps: true, j7z: false, short: [] },
  { ext: "tar.lz4", wraps: true, j7z: false, short: ["tlz4"] },
  { ext: "tar.br", wraps: true, j7z: false, short: ["tbr"] },
  { ext: "tar.sz", wraps: true, j7z: false, short: ["tsz"] },
  { ext: "gz", wraps: false, j7z: true, short: [] },
  { ext: "bz2", wraps: false, j7z: true, short: [] },
  { ext: "xz", wraps: false, j7z: true, short: [] },
];

const stdFiles = { "/d/a.txt": "a", "/d/b.txt": "b", "/e/c.txt": "c" };
const files10: Record<string, string> = {};
for (let i = 1; i <= 10; i++) files10[`/many/${i}.txt`] = `file-${i}`;

let td: string;

// Minimal tar builder for LZ4 test
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "ascii");
  h.write("000644 ", 100, 8, "ascii");
  h.write("000000 ", 108, 7, "ascii");
  h.write("000000 ", 116, 7, "ascii");
  h.write(size.toString(8).padStart(11, "0"), 124, 12, "ascii");
  h.write("00000000000 ", 136, 12, "ascii");
  h.write("0", 156, 1, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  h.write(sum.toString(8).padStart(6, "0") + " ", 148, 8, "ascii");
  return h;
}

function randPad512(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  const pad = Buffer.alloc(512 - rem);
  for (let i = 0; i < pad.length; i++) pad[i] = (i * 7 + 13) % 251 + 1;
  return Buffer.concat([buf, pad]);
}

describe("selective extraction", () => {
  beforeAll(() => {
    td = tmpDir("sat_");
  });

  afterAll(() => {
    fs.rmSync(td, { recursive: true, force: true });
  });

  // ── Selective extraction driven by format matrix ──

  for (const f of FM) {
    if (f.wraps) {
      for (const ext of [f.ext, ...f.short]) {
        if (f.j7z) {
          it(`7z selective: .${ext}`, async () => {
            const b = await createWrapped(stdFiles, ext);
            const r = await j7zSelective(b, ["d/a.txt"]);
            expect(r["d/a.txt"]).toBe("a");
            expect(Object.keys(r).filter((k) => !(k in { "d/a.txt": 1 })).length).toBe(0);
          });
        }
      }
    } else if (f.ext === "gz" || f.ext === "bz2" || f.ext === "xz") {
      if (f.j7z) {
        it(`7z selective: .${f.ext}`, async () => {
          const b = await j7zCompress({ "/data.txt": f.ext }, "/t." + f.ext);
          await j7zSelective(b, ["data.txt"]);
        });
      }
    } else {
      if (f.j7z) {
        it(`7z selective: .${f.ext} single`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt"]);
          expect(r["d/a.txt"]).toBe("a");
          expect(Object.keys(r).filter((k) => !(k in { "d/a.txt": 1 })).length).toBe(0);
        });

        it(`7z selective: .${f.ext} multi`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d/a.txt", "d/b.txt"]);
          expect(r["d/a.txt"]).toBe("a");
          expect(r["d/b.txt"]).toBe("b");
          expect(Object.keys(r).filter((k) => !(k in { "d/a.txt": 1, "d/b.txt": 1 })).length).toBe(0);
        });

        it(`7z selective: .${f.ext} dir`, async () => {
          const b = await j7zCompressDir(stdFiles, "/t." + f.ext);
          const r = await j7zSelective(b, ["d"]);
          expect(r["d/a.txt"]).toBe("a");
          expect(r["d/b.txt"]).toBe("b");
          expect(Object.keys(r).length).toBe(2);
        });
      }
    }
  }

  // ── Edge cases ──

  it("7z selective: WIM", async () => {
    const j = await JS7z();
    try {
      mkdirP(j, "/src");
      j.FS.writeFile("/src/a.txt", new Uint8Array(Buffer.from("wim")));
      j.FS.writeFile("/src/b.txt", new Uint8Array(Buffer.from("no")));
      await run7z(j, ["a", "-twim", "/t.wim", "/src"]);
      const buf = Buffer.from(j.FS.readFile("/t.wim", { encoding: "binary" }));
      const r = await j7zSelective(buf, ["src/a.txt"]);
      expect(r["src/a.txt"]).toBe("wim");
      expect(Object.keys(r).length).toBe(1);
    } finally {
      disposeJS7z(j);
    }
  });

  it("7z selective: nonexistent path", async () => {
    const b = await j7zCompressDir({ "/f.txt": "x" }, "/t.7z");
    const r = await j7zSelective(b, ["no.txt"]);
    expect(Object.keys(r).length).toBe(0);
  });

  it("7z selective: 1-of-10", async () => {
    const b = await j7zCompressDir(files10, "/t.7z");
    const r = await j7zSelective(b, ["many/5.txt"]);
    expect(r["many/5.txt"]).toBe("file-5");
    expect(Object.keys(r).length).toBe(1);
  });

  // ── Encrypted selective extraction ──

  const encFiles = { "/f.txt": "enc" };

  it("7z selective: enc 7z correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.7z", ["-pp4ss", "-mhe=on"]);
    const r = await j7zSelective(b, ["f.txt"], "p4ss");
    expect(r["f.txt"]).toBe("enc");
    expect(Object.keys(r).length).toBe(1);
  });

  it("7z selective: enc 7z wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.7z", ["-pp4ss", "-mhe=on"]);
    await expect(j7zSelective(b, ["f.txt"], "wrong")).rejects.toThrow(/7z exit/);
  });

  it("7z selective: enc ZIP correct pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    const r = await j7zSelective(b, ["f.txt"], "zip");
    expect(r["f.txt"]).toBe("enc");
    expect(Object.keys(r).length).toBe(1);
  });

  it("7z selective: enc ZIP wrong pw", async () => {
    const b = await j7zCompressDir(encFiles, "/t.zip", ["-pzip"]);
    await expect(j7zSelective(b, ["f.txt"], "wrong")).rejects.toThrow(/7z exit/);
  });

  // ── Two-step 7z x for wrapped formats ──

  for (const ext of ["tar.xz", "tar.gz", "tar.bz2", "tgz", "txz"]) {
    it(`7z x-x-ls: .${ext}`, async () => {
      const b = await createWrapped(stdFiles, ext);

      const j1 = await JS7z();
      try {
        j1.FS.writeFile("/a." + ext, new Uint8Array(b));
        j1.FS.mkdir("/_ls1");
        await new Promise<void>((resolve, reject) => {
          j1.onExit = (c: number) => {
            if (c === 0) resolve();
            else reject(new Error(`7z x outer: ${c}`));
          };
          j1.callMain(["x", "/a." + ext, "-o/_ls1", "-y"]);
        });

        const top = j1.FS.readdir("/_ls1").filter((e: string) => e !== "." && e !== "..");
        expect(top.some((e: string) => e.endsWith(".tar"))).toBe(true);

        const innerTar = top.find((e: string) => e.endsWith(".tar"))!;
        const innerData = j1.FS.readFile(`/_ls1/${innerTar}`, { encoding: "binary" });

        const j2 = await JS7z();
        try {
          j2.FS.writeFile("/_inner.tar", new Uint8Array(innerData));
          j2.FS.mkdir("/_ls2");
          await new Promise<void>((resolve, reject) => {
            j2.onExit = (c: number) => {
              if (c === 0) resolve();
              else reject(new Error(`7z x inner: ${c}`));
            };
            j2.callMain(["x", "/_inner.tar", "-o/_ls2", "-y"]);
          });

          const paths = walkFS(j2, "/_ls2", "");
          expect(paths.length).toBeGreaterThan(0);
          expect(paths.some((p) => p.includes("d/a.txt"))).toBe(true);
        } finally {
          disposeJS7z(j2);
        }
      } finally {
        disposeJS7z(j1);
      }
    });
  }

  // ── zstd compression roundtrip ──

  it("zstd roundtrip: compress then self-decompress", async () => {
    const b = await createWrapped(stdFiles, "tar.zst");
    expect(b.length).toBeLessThan(4096);

    const dec = await wasmDecompress(b, "zst");
    expect(dec.length).toBeGreaterThan(100);

    const j = await JS7z();
    try {
      j.FS.writeFile("/_t.tar", dec);
      j.FS.mkdir("/_out");
      await new Promise<void>((resolve, reject) => {
        j.onExit = (c: number) => {
          if (c === 0) resolve();
          else reject(new Error(`7z x tar: ${c}`));
        };
        j.callMain(["x", "/_t.tar", "-o/_out", "-y"]);
      });
      const paths = walkFS(j, "/_out", "");
      expect(paths.includes("d/a.txt")).toBe(true);
      expect(paths.includes("d/b.txt")).toBe(true);
    } finally {
      disposeJS7z(j);
    }
  });

  // ── LZ4 compression roundtrip ──

  it("lz4 init and basic compress", async () => {
    const data = new TextEncoder().encode("hello world lz4 test data");
    const compressed = await wasmCompress(data, "lz4", 5);
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed.length).toBeLessThan(data.length + 64);
    // LZ4 frame magic: 0x04224D18 in little-endian
    expect(compressed[0]).toBe(0x04);
    expect(compressed[1]).toBe(0x22);
    expect(compressed[2]).toBe(0x4d);
    expect(compressed[3]).toBe(0x18);
  });

  it("lz4 roundtrip: tar.lz4 -> self-decompress -> 7z extract", async () => {
    // Build a minimal tar
    const content = Buffer.from("hello from lz4 test\n");
    const entry = Buffer.concat([
      tarHeader("hello.txt", content.length),
      randPad512(content),
    ]);
    const tarBuf = Buffer.concat([entry, Buffer.alloc(1024, 0)]);
    expect(tarBuf.length).toBe(2048);

    // Compress with LZ4
    const compressed = await wasmCompress(new Uint8Array(tarBuf), "lz4", 5);
    expect(compressed.length).toBeGreaterThan(0);

    // Decompress with LZ4 to get inner tar
    const dec = await wasmDecompress(compressed, "lz4");
    expect(dec.length).toBe(tarBuf.length);

    // Extract the tar with 7z to verify contents
    const j = await JS7z();
    try {
      j.FS.writeFile("/_t.tar", dec);
      j.FS.mkdir("/_lz4out");
      await new Promise<void>((resolve, reject) => {
        j.onExit = (c: number) => {
          if (c === 0) resolve();
          else reject(new Error(`7z x tar: ${c}`));
        };
        j.callMain(["x", "/_t.tar", "-o/_lz4out", "-y"]);
      });

      const extracted = j.FS.readFile("/_lz4out/hello.txt", { encoding: "utf8" });
      expect(extracted).toBe("hello from lz4 test\n");
    } finally {
      disposeJS7z(j);
    }
  });

  // ── Multi-frame LZ4 roundtrip (concatenated frames from chunked compress) ──

  it("lz4 multi-frame roundtrip: compress chunks → concat → decompress all", async () => {
    // Simulate chunked compression like lz4CompressFile with small chunks
    const CHUNK = 1024; // deliberately small to produce many frames
    const totalSize = CHUNK * 5; // 5 frames
    const data = new Uint8Array(Buffer.alloc(totalSize).map((_, i) => i % 251));

    // Compress each chunk into an LZ4 frame, concatenate
    const frames: Uint8Array[] = [];
    for (let pos = 0; pos < data.length; pos += CHUNK) {
      const chunk = data.subarray(pos, pos + CHUNK);
      const frame = await wasmCompress(chunk, "lz4", 5);
      frames.push(frame);
    }
    const compressed = Buffer.concat(frames.map((f) => Buffer.from(f)));
    expect(compressed.length).toBeGreaterThan(0);

    // Decompress all frames via the WASM engine
    const parts: Uint8Array[] = [];
    let offset = 0;
    const buf = Buffer.from(compressed);
    const MAGIC = 0x184d2204; // LZ4 frame magic in LE memory order
    while (offset < buf.length) {
      if (offset + 4 > buf.length) break;
      if (buf.readUInt32LE(offset) !== MAGIC) { offset++; continue; }
      let end = offset + 4;
      while (end + 4 <= buf.length && buf.readUInt32LE(end) !== MAGIC) end++;
      if (end + 4 > buf.length) end = buf.length;
      parts.push(await wasmDecompress(buf.subarray(offset, end), "lz4"));
      offset = end;
    }

    const totalParts = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(totalParts);
    let pos = 0;
    for (const p of parts) {
      result.set(p, pos);
      pos += p.length;
    }

    expect(result.length).toBe(data.length);
    expect(Buffer.from(result).equals(Buffer.from(data))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// Brotli round-trip tests
// ════════════════════════════════════════════════════════════════════

describe("brotli", () => {
  it("brotli basic compress and decompress", async () => {
    const data = new TextEncoder().encode("hello brotli compression test data");
    const compressed = await brotliCompress(data, 6);
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed.length).toBeLessThan(data.length + 64);
    const decompressed = await brotliDecompress(compressed);
    expect(decompressed.length).toBe(data.length);
    expect(Buffer.from(decompressed).equals(Buffer.from(data))).toBe(true);
  });

  it("brotli roundtrip: tar.br -> decompress -> 7z extract", async () => {
    const b = await createWrapped(stdFiles, "tar.br");
    expect(b.length).toBeLessThan(4096);

    const dec = await brotliDecompress(new Uint8Array(b));
    expect(dec.length).toBeGreaterThan(100);

    const j = await JS7z();
    try {
      j.FS.writeFile("/_t.tar", dec);
      j.FS.mkdir("/_out");
      await new Promise<void>((resolve, reject) => {
        j.onExit = (c: number) => {
          if (c === 0) resolve();
          else reject(new Error(`7z x tar: ${c}`));
        };
        j.callMain(["x", "/_t.tar", "-o/_out", "-y"]);
      });
      const paths = walkFS(j, "/_out", "");
      expect(paths.includes("d/a.txt")).toBe(true);
      expect(paths.includes("d/b.txt")).toBe(true);
    } finally {
      disposeJS7z(j);
    }
  });

  it("tar.br format constants: ext, wrap, category", () => {
    const fmt = getFormatByExt(".tar.br");
    expect(fmt).toBeDefined();
    expect(fmt!.label).toBe("tar.br");
    expect(fmt!.wrapsTar).toBe(true);
    expect(fmt!.wrapCompression).toBe("br");
    expect(fmt!.canCreate).toBe(true);
    expect(fmt!.supportsEncryption).toBe(false);
    expect(fmt!.category).toBe("wrapped");

    const fmtShort = getFormatByExt(".tbr");
    expect(fmtShort).toBeDefined();
    expect(fmtShort!.label).toBe("tar.br");
    expect(fmtShort!.wrapCompression).toBe("br");

    expect(isWrappedFormat(".tar.br")).toBe(true);
    expect(isWrappedFormat(".tbr")).toBe(true);
    expect(getWrapExtension(".tar.br")).toBe("br");
    expect(getWrapExtension(".tbr")).toBe("br");
    expect(getFullExt("archive.tar.br")).toBe(".tar.br");
    expect(getFullExt("archive.tbr")).toBe(".tbr");
  });

  it("tar.br format: canCompress and short alias works", async () => {
    const b1 = await createWrapped(stdFiles, "tar.br");
    expect(b1.length).toBeLessThan(4096);
    const b2 = await createWrapped(stdFiles, "tbr");
    expect(b2.length).toBeLessThan(4096);
  });

  it("brotli file-to-file roundtrip: compress -> decompress (15MB)", async () => {
    let tdir = tmpDir("sat_");
    const original = path.join(tdir, "original.bin");
    const compressed = path.join(tdir, "compressed.br");
    const decompressed = path.join(tdir, "decompressed.bin");

    try {
      const SIZE = 15 * 1024 * 1024;
      const buf = Buffer.alloc(SIZE);
      for (let i = 0; i < SIZE; i++) {
        buf[i] = (i * 7 + 13) % 251;
      }
      fs.writeFileSync(original, buf);

      await brotliCompressFile(original, compressed, 5);
      const compSize = fs.statSync(compressed).size;
      expect(compSize).toBeGreaterThan(0);
      expect(compSize).toBeLessThan(SIZE);

      await brotliDecompressFile(compressed, decompressed);
      const decBuf = fs.readFileSync(decompressed);
      expect(decBuf.length).toBe(SIZE);
      expect(decBuf.equals(buf)).toBe(true);
    } finally {
      try { fs.rmSync(tdir, { recursive: true, force: true }); } catch {}
    }
  });

  it("brotli file-to-file stream: 100MB multi-frame roundtrip", async () => {
    let tdir = tmpDir("sab_");
    const original = path.join(tdir, "big.bin");
    const compressed = path.join(tdir, "big.br");
    const decompressed = path.join(tdir, "big_out.bin");

    try {
      // 100MB spans 2 compression chunks (50MB each) → tests multi-frame concatenation
      const SIZE = 100 * 1024 * 1024;
      const out = fs.openSync(original, "w");
      const CHUNK_WRITE = 1024 * 1024;
      const pattern = Buffer.alloc(CHUNK_WRITE);
      for (let i = 0; i < CHUNK_WRITE; i++) {
        pattern[i] = (i * 3 + 7) % 173;
      }
      for (let pos = 0; pos < SIZE; pos += CHUNK_WRITE) {
        const n = Math.min(CHUNK_WRITE, SIZE - pos);
        fs.writeSync(out, n === CHUNK_WRITE ? pattern : pattern.subarray(0, n));
      }
      fs.closeSync(out);

      await brotliCompressFile(original, compressed, 5);
      const compSize = fs.statSync(compressed).size;
      expect(compSize).toBeGreaterThan(0);
      expect(compSize).toBeLessThan(SIZE * 0.8);

      await brotliDecompressFile(compressed, decompressed);
      const decSize = fs.statSync(decompressed).size;
      expect(decSize).toBe(SIZE);

      const srcFd = fs.openSync(original, "r");
      const decFd = fs.openSync(decompressed, "r");
      try {
        const bufA = Buffer.alloc(4096);
        const bufB = Buffer.alloc(4096);
        for (const pos of [0, SIZE / 4, SIZE / 2, SIZE * 3 / 4, SIZE - 4096]) {
          fs.readSync(srcFd, bufA, 0, 4096, Math.floor(pos));
          fs.readSync(decFd, bufB, 0, 4096, Math.floor(pos));
          expect(bufA.equals(bufB)).toBe(true);
        }
      } finally {
        fs.closeSync(srcFd);
        fs.closeSync(decFd);
      }
    } finally {
      try { fs.rmSync(tdir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);
});

// ════════════════════════════════════════════════════════════════════
// parse7zListing (production)
// ════════════════════════════════════════════════════════════════════

/** Builds `7z l -slt`-style stdout from entries — a test fixture, not logic. */
function mock7zListing(entries: { path: string; size: number; attr: string }[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`Path = ${e.path}`);
    if (e.size > 0) lines.push(`Size = ${e.size}`);
    if (e.attr) lines.push(`Attributes = ${e.attr}`);
    lines.push("");
  }
  return lines.join("\n");
}

describe("parse7zListing", () => {
  it("basic files and dirs", () => {
    const stdout = mock7zListing([
      { path: "/test.7z", size: 100, attr: "A" },
      { path: "src", size: 0, attr: "D" },
      { path: "src/index.js", size: 42, attr: "A" },
      { path: "src/lib", size: 0, attr: "D" },
      { path: "src/lib/util.js", size: 10, attr: "A" },
      { path: "package.json", size: 5, attr: "A" },
    ]);
    const r = parse7zListing(stdout, "test.7z");
    expect(r.length).toBe(5);
    expect(r[0].path).toBe("src");
    expect(r[0].type).toBe("DIRECTORY");
    expect(r[1].path).toBe("src/index.js");
    expect(r[1].type).toBe("REGULAR_FILE");
    expect(r[1].size).toBe(42);
    expect(r[4].path).toBe("package.json");
    expect(r[4].size).toBe(5);
  });

  it("skips archive self-reference", () => {
    const stdout2 = "Path = archive.7z\nSize = 200\nAttributes = A\n\nPath = readme.md\nSize = 30\nAttributes = A\n\n";
    const r = parse7zListing(stdout2, "archive.7z");
    expect(r.length).toBe(1);
    expect(r[0].path).toBe("readme.md");
  });

  it("empty output returns empty", () => {
    expect(parse7zListing("", "x.7z").length).toBe(0);
    expect(parse7zListing("7-Zip ...\n---\n", "x.7z").length).toBe(0);
  });

  it("handles 7z header lines gracefully", () => {
    const stdout =
      "7-Zip (z) 25.01 ...\n\n" +
      "Scanning the drive:\n" +
      "  0M Scan /\n" +
      "Path = dir/file.txt\nSize = 100\nAttributes = A\n\n" +
      "Path = dir\nSize = 0\nAttributes = D\n\n";
    const r = parse7zListing(stdout, "x.7z");
    expect(r.length).toBe(2);
    expect(r[0].path).toBe("dir/file.txt");
    expect(r[0].size).toBe(100);
    expect(r[1].type).toBe("DIRECTORY");
  });

  it("split volume self-reference filtered", () => {
    const stdout = mock7zListing([
      { path: "/x.7z.001", size: 100, attr: "A" },
      { path: "/x.7z", size: 80, attr: "A" },
      { path: "data.txt", size: 20, attr: "A" },
    ]);
    const r = parse7zListing(stdout, "x.7z.001");
    expect(r.length).toBe(1);
    expect(r[0].path).toBe("data.txt");
  });

  it("size only set on first occurrence", () => {
    const stdout =
      "Path = app.js\nSize = 42\n\n" +
      "Modified = 2024-01-01 00:00:00\n\n" +
      "Path = readme.md\nSize = 100\nAttributes = A\n\n";
    const r = parse7zListing(stdout, "a.7z");
    expect(r[0].path).toBe("app.js");
    expect(r[0].size).toBe(42);
    expect(r[1].size).toBe(100);
  });

  it("CJK filenames preserved", () => {
    const stdout = mock7zListing([
      { path: "中文文件.txt", size: 10, attr: "A" },
      { path: "日本語フォルダ", size: 0, attr: "D" },
    ]);
    const r = parse7zListing(stdout, "a.7z");
    expect(r.length).toBe(2);
    expect(r.some((e) => e.path.includes("中文文件"))).toBe(true);
    expect(r.some((e) => e.type === "DIRECTORY")).toBe(true);
  });
});

describe("markNoisyDirs", () => {
  it("collapses node_modules at root", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/index.js", size: 100, type: "REGULAR_FILE" },
      { path: "src/index.js", size: 42, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "a.7z");
    markNoisyDirs(tree, ["node_modules", ".git"]);
    const nm = tree.find((n) => n.name === "node_modules");
    expect(nm).toBeTruthy();
    expect(nm!.collapsed).toBe(true);
    const src = tree.find((n) => n.name === "src");
    expect(src).toBeTruthy();
    expect(src!.collapsed).toBeUndefined();
  });

  it("collapses nested noisy dirs", () => {
    const entries: FlatEntry[] = [
      { path: "project", size: 0, type: "DIRECTORY" },
      { path: "project/src", size: 0, type: "DIRECTORY" },
      { path: "project/src/node_modules", size: 0, type: "DIRECTORY" },
      { path: "project/src/node_modules/lib.js", size: 10, type: "REGULAR_FILE" },
      { path: "project/.git", size: 0, type: "DIRECTORY" },
      { path: "project/.git/HEAD", size: 5, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "a.7z");
    markNoisyDirs(tree, ["node_modules", ".git"]);
    const project = tree.find((n) => n.name === "project");
    expect(project!.collapsed).toBeUndefined();
    const git = project!.children!.find((c) => c.name === ".git");
    expect(git!.collapsed).toBe(true);
    const src = project!.children!.find((c) => c.name === "src");
    expect(src).toBeTruthy();
    const nm = src!.children!.find((c) => c.name === "node_modules");
    expect(nm!.collapsed).toBe(true);
  });

  it("children of noisy dir also collapsed", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/lib", size: 0, type: "DIRECTORY" },
      { path: "node_modules/express/lib/app.js", size: 50, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "a.7z");
    markNoisyDirs(tree, ["node_modules"]);
    const nm = tree[0];
    expect(nm.collapsed).toBe(true);
    const express = nm.children![0];
    expect(express.collapsed).toBe(true);
    const lib = express.children![0];
    expect(lib.collapsed).toBe(true);
  });

  it("empty patterns does nothing", () => {
    const entries: FlatEntry[] = [
      { path: "node_modules/lib.js", size: 10, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "a.7z");
    markNoisyDirs(tree, []);
    expect(tree[0].collapsed).toBeUndefined();
  });

  it("glob patterns work", () => {
    const entries: FlatEntry[] = [
      { path: "logs", size: 0, type: "DIRECTORY" },
      { path: "logs/error.log", size: 20, type: "REGULAR_FILE" },
      { path: "logs/info.log", size: 15, type: "REGULAR_FILE" },
      { path: "src/main.ts", size: 30, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "a.7z");
    markNoisyDirs(tree, ["*.log"]);
    const logs = tree.find((n) => n.name === "logs");
    expect(logs!.collapsed).toBeUndefined();
  });

  it("dotfile dirs collapsed", () => {
    const entries: FlatEntry[] = [
      { path: ".npm", size: 0, type: "DIRECTORY" },
      { path: ".npm/_cacache", size: 0, type: "DIRECTORY" },
      { path: ".vscode", size: 0, type: "DIRECTORY" },
      { path: ".vscode/settings.json", size: 8, type: "REGULAR_FILE" },
      { path: "src/app.ts", size: 12, type: "REGULAR_FILE" },
    ];
    const tree = buildTree(entries, "a.7z");
    markNoisyDirs(tree, [".npm", ".vscode"]);
    expect(tree.find((n) => n.name === ".npm")!.collapsed).toBe(true);
    expect(tree.find((n) => n.name === ".vscode")!.collapsed).toBe(true);
    expect(tree.find((n) => n.name === "src")!.collapsed).toBeUndefined();
  });
});
