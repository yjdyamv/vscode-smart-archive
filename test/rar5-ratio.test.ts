/**
 * Recovery-record aware compression ratio — Smart Archiver
 *
 * The RAR5 recovery record appends parity data that inflates the on-disk
 * archive size; getRarPayloadSize must return the protected payload so
 * the webview ratio is not skewed.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { getRarPayloadSize, getRarPayloadSizeForSet } from "../src/providers/archive/rar5-modify";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

// Needs a real RAR5 engine (native binding or WASI fallback); the bare
// `check` CI job stages neither, so these tests run where one is available.
const HAS_RAR5_ENGINE = gate("rar5Binding") || gate("rar5Wasm");

const FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

describe("getRarPayloadSize (recovery record)", () => {
  it.runIf(HAS_RAR5_ENGINE)("excludes the RR parity tail from the ratio size", async () => {
    const dir = tmpDir("sat_ratio-");
    try {
      const file = path.join(dir, "data.bin");
      fs.writeFileSync(file, "payload ".repeat(2000));
      const archive = path.join(dir, "rr.rar");
      await compressWithRar5(
        {
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: file }],
          password: "",
          recoveryPercent: 20,
          level: 3,
        },
        undefined,
        undefined,
        [],
      );
      const full = fs.statSync(archive).size;
      const payload = getRarPayloadSize(archive, full);
      expect(payload).toBeGreaterThan(0);
      expect(payload).toBeLessThan(full);
      expect(full - payload).toBeGreaterThan(100);
      // The payload must not include the {RB} parity tail.
      const rb = fs.readFileSync(archive).indexOf(Buffer.from("{RB}"));
      expect(rb).toBeGreaterThan(0);
      expect(payload).toBeLessThanOrEqual(rb);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(HAS_RAR5_ENGINE)("falls back to the full size for archives without RR or non-RAR", async () => {    const dir = tmpDir("sat_ratio2-");
    try {
      const plain = path.join(dir, "plain.bin");
      fs.writeFileSync(plain, "not a rar");
      expect(getRarPayloadSize(plain, 100)).toBe(100);

      const file = path.join(dir, "data.bin");
      fs.writeFileSync(file, "x".repeat(1000));
      const archive = path.join(dir, "no-rr.rar");
      await compressWithRar5(
        { format: FORMAT, outputPath: archive, targets: [{ fsPath: file }], level: 3 },
        undefined,
        undefined,
        [],
      );
      const full = fs.statSync(archive).size;
      expect(getRarPayloadSize(archive, full)).toBe(full);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(HAS_RAR5_ENGINE)("excludes the RR parity tail from the ratio size for header-encrypted archives", async () => {
    const dir = tmpDir("sat_ratio3-");
    try {
      const file = path.join(dir, "data.bin");
      fs.writeFileSync(file, "payload ".repeat(2000));
      const archive = path.join(dir, "hp-rr.rar");
      await compressWithRar5(
        {
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: file }],
          password: "hunter2",
          encryptHeaders: true,
          recoveryPercent: 20,
          level: 3,
        },
        undefined,
        undefined,
        [],
      );
      const full = fs.statSync(archive).size;
      const payload = getRarPayloadSize(archive, full);
      expect(payload).toBeGreaterThan(0);
      expect(payload).toBeLessThan(full);
      expect(full - payload).toBeGreaterThan(100);
      const rb = fs.readFileSync(archive).indexOf(Buffer.from("{RB}"));
      expect(rb).toBeGreaterThan(0);
      expect(payload).toBeLessThanOrEqual(rb);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(HAS_RAR5_ENGINE)("sums the per-volume RR payload across a split set", async () => {
    const dir = tmpDir("sat_ratio-split-");
    try {
      // Random (incompressible) payload so the archive really splits.
      const file = path.join(dir, "data.bin");
      fs.writeFileSync(file, require("crypto").randomBytes(100_000));
      const archive = path.join(dir, "set.part1.rar");
      await compressWithRar5(
        {
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: file }],
          password: "",
          level: 3,
          volumeSize: "32k",
          recoveryPercent: 10,
        },
        undefined,
        undefined,
        [],
      );
      const volumes = fs
        .readdirSync(dir)
        .filter((f) => /\.part\d+\.rar$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f));
      expect(volumes.length).toBeGreaterThan(1);
      const full = volumes.reduce((sum, v) => sum + fs.statSync(v).size, 0);
      const payload = getRarPayloadSizeForSet(archive);
      // Every volume's own RR tail is excluded, and the whole set counts —
      // not just the first volume (the old single-file bug).
      expect(payload).toBeGreaterThan(0);
      expect(payload).toBeLessThan(full);
      expect(payload).toBeGreaterThan(fs.statSync(volumes[0]).size);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
