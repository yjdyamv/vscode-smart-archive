/**
 * 7zz-wasm codec tests — Smart Archive VSCode Extension
 *
 * Verifies the WASM codec engine for the single-file stream codecs
 * (zstd / brotli / lz4): parallel zstd output, standard brotli/lz4
 * streams, and concatenated-frame handling.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "node:zlib";
import { setForceWasmCodec } from "../src/engines/js7z-codec";
import {
  wasmCompress,
  wasmCompressFile,
  wasmDecompress,
  wasmDecompressFile,
} from "../src/engines/js7z-codec";
import { brotliDecompressFile } from "../src/engines/brotli-codec";
import { lz4DecompressFile } from "../src/engines/lz4-codec";

const zstd = require("zstd-napi") as {
  compress: (data: Buffer, opts?: { compressionLevel?: number }) => Buffer;
  decompress: (data: Buffer) => Buffer;
};
const lz4 = require("lz4-napi") as {
  compressFrame: (data: Uint8Array) => Promise<Buffer>;
  decompressFrame: (data: Uint8Array) => Promise<Buffer>;
};

function makeData(size = 512 * 1024): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (i * 7 + (i >> 8)) % 251;
  }
  return buf;
}

describe("7zz-wasm codec fallback", () => {
  let tmpDir: string;

  beforeAll(() => {
    setForceWasmCodec(true);
  });

  afterAll(() => {
    setForceWasmCodec(false);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_wasmcodec_"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const codec of ["zst", "br", "lz4"] as const) {
    it(`${codec} file round-trip through WASM`, async () => {
      const data = makeData();
      const input = path.join(tmpDir, `input.${codec === "zst" ? "tar" : codec}`);
      const compressed = path.join(tmpDir, `out.${codec}`);
      const restored = path.join(tmpDir, `restored.${codec === "zst" ? "tar" : codec}`);
      fs.writeFileSync(input, data);

      await wasmCompressFile(input, compressed, codec, 5);
      expect(fs.statSync(compressed).size).toBeGreaterThan(0);

      await wasmDecompressFile(compressed, restored, codec);
      expect(fs.readFileSync(restored)).toEqual(data);
    });

    it(`${codec} buffer round-trip through WASM`, async () => {
      const data = makeData(256 * 1024);
      const compressed = await wasmCompress(data, codec, 5);
      const restored = await wasmDecompress(compressed, codec);
      expect(Buffer.from(restored)).toEqual(data);
    });
  }

  it("WASM zstd output is decodable by zstd-napi and vice versa", async () => {
    const data = makeData();
    const wasmOut = await wasmCompress(data, "zst", 5);
    expect(Buffer.compare(zstd.decompress(Buffer.from(wasmOut)), data)).toBe(0);

    const nativeOut = zstd.compress(data, { compressionLevel: 9 });
    expect(Buffer.from(await wasmDecompress(nativeOut, "zst"))).toEqual(data);
  });

  it("WASM lz4 output is a standard frame and round-trips through wasm", async () => {
    const data = makeData();
    const wasmOut = await wasmCompress(data, "lz4", 5);
    // Standard LZ4 frame magic (no 7-Zip ZS MT container).
    expect([...wasmOut.subarray(0, 4)]).toEqual([0x04, 0x22, 0x4d, 0x18]);
    // Native lz4-napi and the WASM engine both decode it.
    expect(Buffer.from(await lz4.decompressFrame(wasmOut))).toEqual(data);
    expect(Buffer.from(await wasmDecompress(wasmOut, "lz4"))).toEqual(data);

    const nativeOut = Buffer.from(await lz4.compressFrame(data));
    expect(Buffer.from(await wasmDecompress(nativeOut, "lz4"))).toEqual(data);
  });

  it("WASM brotli output is a standard stream and round-trips through wasm", async () => {
    const data = makeData();
    const wasmOut = await wasmCompress(data, "br", 5);
    // Standard raw brotli stream: node:zlib and the WASM engine both decode.
    expect(Buffer.from(zlib.brotliDecompressSync(Buffer.from(wasmOut)))).toEqual(data);
    expect(Buffer.from(await wasmDecompress(wasmOut, "br"))).toEqual(data);

    const nativeOut = zlib.brotliCompressSync(data, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
    });
    expect(Buffer.from(await wasmDecompress(nativeOut, "br"))).toEqual(data);
  });

  it("file-level brotli/lz4 decompression routes through wasm", async () => {
    const data = makeData();
    for (const codec of ["br", "lz4"] as const) {
      const compressed = path.join(tmpDir, `mt.${codec}`);
      const restored = path.join(tmpDir, `mt-restored.${codec}`);
      fs.writeFileSync(compressed, Buffer.from(await wasmCompress(data, codec, 5)));
      if (codec === "br") {
        await brotliDecompressFile(compressed, restored);
      } else {
        await lz4DecompressFile(compressed, restored);
      }
      expect(fs.readFileSync(restored)).toEqual(data);
    }
  });

  it("WASM decompression handles concatenated zstd frames", async () => {
    const data = makeData(300 * 1024);
    const frames: Buffer[] = [];
    for (let pos = 0; pos < data.length; pos += 64 * 1024) {
      frames.push(zstd.compress(data.subarray(pos, pos + 64 * 1024), { compressionLevel: 3 }));
    }
    const restored = await wasmDecompress(Buffer.concat(frames), "zst");
    expect(Buffer.from(restored)).toEqual(data);
  });

  it("WASM decompression handles concatenated lz4 frames", async () => {
    const data = makeData(300 * 1024);
    const frames: Buffer[] = [];
    for (let pos = 0; pos < data.length; pos += 64 * 1024) {
      frames.push(Buffer.from(await lz4.compressFrame(new Uint8Array(data.subarray(pos, pos + 64 * 1024)))));
    }
    const restored = await wasmDecompress(Buffer.concat(frames), "lz4");
    expect(Buffer.from(restored)).toEqual(data);
  });

});
