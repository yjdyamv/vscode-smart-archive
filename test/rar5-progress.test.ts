/**
 * RAR5 compression progress regression tests — Smart Archive
 *
 * Reproduces the two progress-accounting bugs fixed in rar-rs 23733cc+ and
 * smart-archive-rar 0.2.10:
 *   1. directory entries used to be counted again in the binding's `total`,
 *      so folder compression stalled around 50% until the terminal event;
 *   2. >64 MiB members (streaming sequential path) double-reported their
 *      bytes, so `done` could exceed `total`.
 * Gated on the staged linux-x64 binding; skipped elsewhere.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { compressWithRar5 } from "../src/engines/rar5-engine";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

const BINDING = path.join(
  __dirname,
  "..",
  "rar5-bin",
  "linux",
  "x64",
  "smart-archive-rar.linux-x64-gnu.node",
);

interface Report {
  message?: string;
  increment?: number;
}

function pctReports(reports: Report[]): number[] {
  return reports
    .filter((r) => r.message?.match(/^\d+%$/))
    .map((r) => parseInt(r.message!, 10));
}

function expectMonotonic(pcts: number[]): void {
  expect(pcts.length).toBeGreaterThan(2);
  for (let i = 1; i < pcts.length; i++) {
    expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
  }
}

describe("rar5 compress progress", () => {
  it.runIf(fs.existsSync(BINDING))(
    "folder compression does not stall mid-way (directory double-count regression)",
    async () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5prog_"));
      try {
        const src = path.join(td, "src");
        fs.mkdirSync(src);
        for (let i = 0; i < 24; i++) {
          fs.writeFileSync(path.join(src, `small-${i}.bin`), Buffer.alloc(256 * 1024, i % 251));
        }
        const out = path.join(td, "out.rar");

        const reports: Report[] = [];
        await compressWithRar5(
          {
            format: RAR5_FORMAT,
            outputPath: out,
            targets: [{ fsPath: src }],
            password: "",
            level: 3,
          },
          { report: (r) => reports.push(r) } as never,
        );

        expect(fs.existsSync(out)).toBe(true);
        const pcts = pctReports(reports);
        expectMonotonic(pcts);
        expect(pcts[pcts.length - 1]).toBe(100);
        // The per-member events must carry the bar to ~100% before the
        // terminal event; with the old double-counted `total` they stalled
        // around 50% and then jumped.
        expect(pcts[pcts.length - 2]).toBeGreaterThanOrEqual(90);
      } finally {
        fs.rmSync(td, { recursive: true, force: true });
      }
    },
  );

  it.runIf(fs.existsSync(BINDING))(
    "a >64 MiB member reports monotonically without exceeding 100%",
    async () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5prog2_"));
      try {
        const big = path.join(td, "big.bin");
        const chunk = Buffer.alloc(4 * 1024 * 1024, 7);
        const fd = fs.openSync(big, "w");
        for (let i = 0; i < 17; i++) fs.writeSync(fd, chunk);
        fs.closeSync(fd);
        const out = path.join(td, "out.rar");

        const reports: Report[] = [];
        await compressWithRar5(
          {
            format: RAR5_FORMAT,
            outputPath: out,
            targets: [{ fsPath: big }],
            password: "",
            level: 3,
          },
          { report: (r) => reports.push(r) } as never,
        );

        expect(fs.existsSync(out)).toBe(true);
        const pcts = pctReports(reports);
        expectMonotonic(pcts);
        expect(pcts[pcts.length - 1]).toBe(100);
        for (const pct of pcts) {
          expect(pct).toBeLessThanOrEqual(100);
        }
      } finally {
        fs.rmSync(td, { recursive: true, force: true });
      }
    },
  );
});
