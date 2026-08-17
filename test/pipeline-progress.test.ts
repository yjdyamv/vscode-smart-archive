/**
 * Full-pipeline progress tests — Smart Archiver VSCode Extension
 *
 * Verifies that multi-phase compression pipelines report continuous,
 * monotonically increasing, phase-scaled progress (tar packing → codec),
 * so the progress bar spans the whole operation instead of stalling.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "node:crypto";
import { compressWith7z } from "../src/engines/js7z-compress";
import { compressWith7z as compressWasmCore } from "../src/engines/js7z-compress-core";
import { compressWithSystem7z } from "../src/engines/system7z";

import { itIf } from "./gates";
import { tmpDir } from "./tmp";

interface Report {
  stage?: "copy" | "pack" | "compress";
  message?: string;
  increment?: number;
}

function stagePcts(reports: Report[], stage: Report["stage"]): number[] {
  return reports
    .filter((r) => r.stage === stage)
    .filter((r) => r.message?.match(/^\d+%$/))
    .map((r) => parseInt(r.message!, 10));
}

function expectStageProgress(pcts: number[]): void {
  expect(pcts.length).toBeGreaterThan(2);
  for (let i = 1; i < pcts.length; i++) {
    expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
  }
  // Each stage's own bar must reach the end of that stage. The system-7z
  // size-monitor may stop a few points early when the process finishes.
  expect(pcts[pcts.length - 1]).toBeGreaterThanOrEqual(85);
}

describe("full-pipeline compress progress", () => {
  it("WASM wrapped pipeline (tar.br) scales progress across tar + codec", async () => {
    const td = tmpDir("sat_full_");
    const src = path.join(td, "data.bin");
    // 5 × 50 MiB codec chunks → multiple reports in both phases. Random
    // data keeps the WASM brotli phase emitting percent updates
    // (zeros finish too fast, and 120 MiB yields only two percent ticks).
    fs.writeFileSync(src, crypto.randomBytes(250 * 1024 * 1024));
    const out = path.join(td, "data.tar.br");

    const reports: Report[] = [];
    await compressWith7z(
      {
        targets: [{ fsPath: src }],
        format: { label: "tar.br", description: "", canCreate: true, supportsEncryption: true },
        outputPath: out,
        password: "",
        level: 1,
      },
      { report: (r) => reports.push(r) } as never,
    );

    expect(fs.existsSync(out)).toBe(true);
    // Both pipeline stages report their own 0–100% bar: packing and codec.
    expectStageProgress(stagePcts(reports, "pack"));
    expectStageProgress(stagePcts(reports, "compress"));
    fs.rmSync(td, { recursive: true, force: true });
  });

  it("WASM volume compression (worker core, password) reports compression-phase progress", async () => {
    const td = tmpDir("sat_vol_");
    const src = path.join(td, "data.bin");
    // Incompressible random data split into several 1m volumes so the
    // WASM compression phase takes long enough to emit multiple reports.
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < chunk.length; i += 4) {
      chunk.writeUInt32LE((i * 2654435761) >>> 0, i);
    }
    fs.writeFileSync(src, chunk);
    const out = path.join(td, "data.7z");

    const reports: Report[] = [];
    await compressWasmCore(
      {
        targets: [{ fsPath: src }],
        format: { label: "7z", description: "", canCreate: true, supportsEncryption: true },
        outputPath: out,
        password: "test1234",
        level: 5,
        volumeSize: "1m",
      },
      { report: (r) => reports.push(r) } as never,
    );

    expect(fs.existsSync(`${out}.001`)).toBe(true);
    // Copy opens its own bar, then the compression stage keeps reporting
    // to 100% (regression: print bridge installed too late).
    expect(stagePcts(reports, "copy").length).toBeGreaterThan(0);
    const compressPcts = stagePcts(reports, "compress");
    expect(compressPcts.length).toBeGreaterThan(0);
    expect(compressPcts[compressPcts.length - 1]).toBeGreaterThanOrEqual(90);
    fs.rmSync(td, { recursive: true, force: true });
  });


  itIf("system7z", "system-7z wrapped pipeline (tar.gz) scales progress across tar + gzip", async () => {
    const td = tmpDir("sat_full2_");
    const src = path.join(td, "data.bin");
    // Incompressible data so the gzip step takes long enough to emit
    // multiple size-monitor reports.
    const chunk = Buffer.alloc(64 * 1024 * 1024);
    for (let i = 0; i < chunk.length; i += 4) {
      chunk.writeUInt32LE((i * 2654435761) >>> 0, i);
    }
    fs.writeFileSync(src, chunk);
    const out = path.join(td, "data.tar.gz");

    const reports: Report[] = [];
    await compressWithSystem7z(
      {
        targets: [{ fsPath: src }],
        format: { label: "tar.gz", description: "", canCreate: true, supportsEncryption: true },
        outputPath: out,
        password: "",
        level: 5,
      },
      { report: (r) => reports.push(r) } as never,
    );

    expect(fs.existsSync(out)).toBe(true);
    expectStageProgress(stagePcts(reports, "pack"));
    expectStageProgress(stagePcts(reports, "compress"));
    fs.rmSync(td, { recursive: true, force: true });
  });
});
