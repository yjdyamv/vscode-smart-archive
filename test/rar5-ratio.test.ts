/**
 * Recovery-record aware compression ratio — Smart Archive
 *
 * The RAR5 recovery record appends parity data that inflates the on-disk
 * archive size; getRarPayloadSize must return the protected payload so
 * the webview ratio is not skewed.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { getRarPayloadSize } from "../src/providers/archive/rar5-modify";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

const FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

describe("getRarPayloadSize (recovery record)", () => {
  it("excludes the RR parity tail from the ratio size", async () => {
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

  it("falls back to the full size for archives without RR or non-RAR", async () => {
    const dir = tmpDir("sat_ratio2-");
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
});
