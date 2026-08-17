/**
 * Codec progress tests — Smart Archiver VSCode Extension
 *
 * Verifies that the wrapped-format codecs (zstd/lz4/brotli/snappy) report
 * determinate progress (message + increment) while compressing, so the
 * tar.zst / tar.lz4 / tar.br / tar.sz formats get a real progress bar.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "node:crypto";
import { lz4CompressFile } from "../src/engines/lz4-codec";
import { snappyCompressFile } from "../src/engines/snappy-codec";
import { brotliCompressFile } from "../src/engines/brotli-codec";
import {
  zstdCompressFile,
} from "../src/engines/zstd-codec";
import { applyEngineConfig, DEFAULT_ENGINE_CONFIG } from "../src/engines/engine-config";
import { setForceWasmCodec } from "../src/engines/js7z-codec";
import { tmpDir } from "./tmp";

function makeInput(name: string, sizeMb = 120, random = false): string {
  const dir = tmpDir("sat_codec_");
  const input = path.join(dir, name);
  // 3 × 50 MiB codec chunks → multiple progress reports. Zeros compress
  // quickly so the tests stay fast.
  const size = sizeMb * 1024 * 1024;
  fs.writeFileSync(input, random ? crypto.randomBytes(size) : Buffer.alloc(size));
  return input;
}

function expectDeterminateProgress(reports: { message?: string; increment?: number }[]): void {
  const pctReports = reports.filter((r) => r.message?.match(/^\d+%$/));
  expect(pctReports.length).toBeGreaterThan(0);
  expect(pctReports.some((r) => (r.increment ?? 0) > 0)).toBe(true);
  expect(pctReports[pctReports.length - 1].increment).toBeGreaterThan(0);
}

describe("codec compress progress", () => {
  it("lz4 reports message + increment", async () => {
    // Default lz4 compression runs through the WASM engine;
    // random data keeps the 7zz progress bar emitting percents.
    const input = makeInput("in.tar", 120, true);
    const output = input + ".lz4";
    const reports: { message?: string; increment?: number }[] = [];
    await lz4CompressFile(input, output, 5, { report: (r) => reports.push(r) });
    expect(fs.existsSync(output)).toBe(true);
    expectDeterminateProgress(reports);
    fs.rmSync(path.dirname(input), { recursive: true, force: true });
  });

  it("snappy reports message + increment", async () => {
    const input = makeInput("in.tar");
    const output = input + ".sz";
    const reports: { message?: string; increment?: number }[] = [];
    await snappyCompressFile(input, output, 5, { report: (r) => reports.push(r) });
    expect(fs.existsSync(output)).toBe(true);
    expectDeterminateProgress(reports);
    fs.rmSync(path.dirname(input), { recursive: true, force: true });
  });

  it("brotli reports message + increment", async () => {
    // Default brotli compression runs through the WASM
    // engine; random data keeps the 7zz progress bar emitting percents.
    const input = makeInput("in.tar", 120, true);
    const output = input + ".br";
    const reports: { message?: string; increment?: number }[] = [];
    await brotliCompressFile(input, output, 1, { report: (r) => reports.push(r) });
    expect(fs.existsSync(output)).toBe(true);
    expectDeterminateProgress(reports);
    fs.rmSync(path.dirname(input), { recursive: true, force: true });
  });

  it("zstd (native path) reports message + increment", async () => {
    applyEngineConfig({ ...DEFAULT_ENGINE_CONFIG, zstdBackend: "bundled" }, { warn: () => {} });
    try {
      const input = makeInput("in.tar");
      const output = input + ".zst";
      const reports: { message?: string; increment?: number }[] = [];
      await zstdCompressFile(input, output, 5, { report: (r) => reports.push(r) });
      expect(fs.existsSync(output)).toBe(true);
      expectDeterminateProgress(reports);
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
    } finally {
      applyEngineConfig({ ...DEFAULT_ENGINE_CONFIG }, { warn: () => {} });
    }
  });
});

describe("codec compress progress (WASM fallback)", () => {
  afterEach(() => {
    setForceWasmCodec(false);
  });

  for (const [label, codec, run] of [
    [
      "zst",
      "zst",
      (input: string, output: string, progress: { report: (r: { message?: string }) => void }) =>
        zstdCompressFile(input, output, 5, progress),
    ],
    [
      "br",
      "br",
      (input: string, output: string, progress: { report: (r: { message?: string }) => void }) =>
        brotliCompressFile(input, output, 1, progress),
    ],
    [
      "lz4",
      "lz4",
      (input: string, output: string, progress: { report: (r: { message?: string }) => void }) =>
        lz4CompressFile(input, output, 5, progress),
    ],
  ] as const) {
    it(`${label} reports message + increment through WASM`, async () => {
      setForceWasmCodec(true);
      // Random data keeps the wasm compression phase long enough for the
      // 7zz progress bar to emit percent updates (zeros finish too fast).
      const input = makeInput(`in-${codec}.tar`, 120, true);
      const output = `${input}.${codec}`;
      const reports: { message?: string; increment?: number }[] = [];
      await run(input, output, {
        report: (r: { message?: string; increment?: number }) => reports.push(r),
      } as never);
      expect(fs.existsSync(output)).toBe(true);
      expectDeterminateProgress(reports);
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
    });
  }
});
