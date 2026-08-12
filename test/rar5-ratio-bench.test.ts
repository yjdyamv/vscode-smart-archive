/**
 * Benchmark: 1 GiB archive with a 20% recovery record — payload walk
 * (archive-view ratio), append and delete timing.
 *   npx vitest run test/rar5-ratio-bench.test.ts
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  compressWithRar5,
  appendWithRar5,
  deleteWithRar5,
  listRar5Entries,
} from "../src/engines/rar5-engine";
import { getRarPayloadSize } from "../src/providers/archive/rar5-modify";

const FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

function makeFile(p: string, mb: number): void {
  const chunk = crypto.randomBytes(1024 * 1024);
  const fh = fs.openSync(p, "w");
  for (let i = 0; i < mb; i++) fs.writeSync(fh, chunk);
  fs.closeSync(fh);
}

describe("1 GiB + 20% recovery record (manual)", () => {
  // 1 GiB benchmark — opt-in like test/rar5-big-modify.test.ts:
  //   SAT_BIG_E2E=1 npx vitest run test/rar5-ratio-bench.test.ts
  it.runIf(process.env.SAT_BIG_E2E === "1")("measures payload walk, append and delete", async () => {
    const dir = fs.mkdtempSync(path.join("/home/yuan/.sat-rr1g-"));
    try {
      const big = path.join(dir, "big.bin");
      makeFile(big, 1024); // 1 GiB
      const archive = path.join(dir, "big.rar");

      let t0 = Date.now();
      await compressWithRar5(
        {
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: big }],
          password: "",
          recoveryPercent: 20,
          level: 0,
        },
        undefined,
        undefined,
        [],
      );
      const createMs = Date.now() - t0;
      const full = fs.statSync(archive).size;

      // payload walk (called on every archive-view open)
      const walkTimes: number[] = [];
      let payload = 0;
      for (let i = 0; i < 5; i++) {
        const t1 = Date.now();
        payload = getRarPayloadSize(archive, full);
        walkTimes.push(Date.now() - t1);
      }
      expect(payload).toBeGreaterThan(0);
      expect(payload).toBeLessThan(full);

      // append a small folder (RR is rebuilt over the whole archive)
      const extra = path.join(dir, "extra");
      fs.mkdirSync(extra, { recursive: true });
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(extra, `n${i}.txt`), `x${i}`);
      t0 = Date.now();
      await appendWithRar5(archive, [extra], "", "", []);
      const appendMs = Date.now() - t0;
      expect(listRar5Entries(archive)).toContain("extra/n0.txt");

      // delete it back
      t0 = Date.now();
      const deleted = deleteWithRar5(archive, ["extra"], "");
      const deleteMs = Date.now() - t0;
      expect(deleted).toBeGreaterThan(0);

      console.log(
        `[rr1g] create=${createMs}ms size=${full} (RR ~${Math.round(
          ((full - payload) / full) * 100,
        )}%) walk=${walkTimes.join("/")}ms payload=${payload} append=${appendMs}ms delete=${deleteMs}ms`,
      );
      expect(Math.min(...walkTimes)).toBeLessThan(50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
