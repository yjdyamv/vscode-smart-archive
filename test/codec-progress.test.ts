/**
 * Codec progress tests — Smart Archive VSCode Extension
 *
 * Verifies that the wrapped-format codecs (zstd/lz4/brotli/snappy) report
 * determinate progress (message + increment) while compressing, so the
 * tar.zst / tar.lz4 / tar.br / tar.sz formats get a real progress bar.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lz4CompressFile } from "../src/engines/lz4-codec";
import { snappyCompressFile } from "../src/engines/snappy-codec";
import { brotliCompressFile } from "../src/engines/brotli-codec";
import {
  zstdCompressFile,
  setZstdConfig,
  resetZstdDetectionCache,
} from "../src/engines/zstd-codec";

function makeInput(name: string, sizeMb = 120): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_codec_"));
  const input = path.join(dir, name);
  // 3 × 50 MiB codec chunks → multiple progress reports. Zeros compress
  // quickly so the tests stay fast.
  fs.writeFileSync(input, Buffer.alloc(sizeMb * 1024 * 1024));
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
    const input = makeInput("in.tar");
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
    const input = makeInput("in.tar");
    const output = input + ".br";
    const reports: { message?: string; increment?: number }[] = [];
    await brotliCompressFile(input, output, 1, { report: (r) => reports.push(r) });
    expect(fs.existsSync(output)).toBe(true);
    expectDeterminateProgress(reports);
    fs.rmSync(path.dirname(input), { recursive: true, force: true });
  });

  it("zstd (native path) reports message + increment", async () => {
    setZstdConfig({ useSystemZstd: "never" });
    resetZstdDetectionCache();
    try {
      const input = makeInput("in.tar");
      const output = input + ".zst";
      const reports: { message?: string; increment?: number }[] = [];
      await zstdCompressFile(input, output, 5, { report: (r) => reports.push(r) });
      expect(fs.existsSync(output)).toBe(true);
      expectDeterminateProgress(reports);
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
    } finally {
      setZstdConfig({});
      resetZstdDetectionCache();
    }
  });
});
