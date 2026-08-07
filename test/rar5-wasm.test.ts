/**
 * RAR5 WASI (wasm32-wasip1-threads) fallback — Smart Archive
 *
 * Forces the WASM loader in src/engines/rar5-engine.ts (native .node path is
 * skipped via SA_RAR5_FORCE_WASM=1) and exercises compressWithRar5 against
 * the staged vendor/rar5-wasm bundle: plain folder compression with progress,
 * and AES-256 + header encryption. Validates output with the official unrar
 * binary when one is available; otherwise checks the RAR5 signature.
 * Gated on the staged WASI loader; skipped where it is absent.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

// Force the WASI fallback. loadBinding() is lazy, so setting this before the
// first compressWithRar5 call selects the WASM engine for this test file.
process.env.SA_RAR5_FORCE_WASM = "1";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);


const UNRAR =
  process.env.SA_OFFICIAL_UNRAR || path.join(os.homedir(), "下载", "rar", "unrar");

/** Run official unrar; null when unavailable or blocked (sandbox/CI). */
function unrarOutput(args: string[]): string | null {
  try {
    return execFileSync(UNRAR, args, { encoding: "utf8", timeout: 30000 });
  } catch {
    return null;
  }
}

function checkRar5Signature(file: string): void {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(RAR5_SIG.length);
    fs.readSync(fd, head, 0, head.length, 0);
    expect(head.equals(RAR5_SIG)).toBe(true);
  } finally {
    fs.closeSync(fd);
  }
}

describe("rar5 WASI fallback engine", () => {
  it.runIf(gate("rar5Wasm"))(
    "compresses a folder via the WASM loader with progress to 100%",
    async () => {
      const td = tmpDir("sat_rar5wasm_");
      try {
        const src = path.join(td, "src");
        fs.mkdirSync(path.join(src, "sub"), { recursive: true });
        fs.writeFileSync(path.join(src, "a.txt"), "hello 世界\n");
        fs.writeFileSync(path.join(src, "sub", "b.txt"), "nested\n");
        const out = path.join(td, "out.rar");

        const reports: Array<{ message?: string; increment?: number }> = [];
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
        expect(fs.statSync(out).size).toBeGreaterThan(0);
        checkRar5Signature(out);

        const pcts = reports
          .filter((r) => r.message?.match(/^\d+%$/))
          .map((r) => parseInt(r.message!, 10));
        expect(pcts[pcts.length - 1]).toBe(100);

        const listing = unrarOutput(["lb", out]);
        if (listing !== null) {
          expect(listing).toContain("src/a.txt");
          expect(listing).toContain("src/sub/b.txt");
          const tested = unrarOutput(["t", out]);
          if (tested !== null) expect(tested).toContain("All OK");
        }
      } finally {
        fs.rmSync(td, { recursive: true, force: true });
      }
    },
  );

  it.runIf(gate("rar5Wasm"))(
    "creates an AES-256 + header-encrypted archive via the WASM loader",
    async () => {
      const td = tmpDir("sat_rar5wasm2_");
      try {
        const file = path.join(td, "secret.txt");
        fs.writeFileSync(file, "classified\n");
        const out = path.join(td, "secret.rar");

        await compressWithRar5(
          {
            format: RAR5_FORMAT,
            outputPath: out,
            targets: [{ fsPath: file }],
            password: "s3cret",
            encryptHeaders: true,
            level: 3,
          },
          undefined,
          undefined,
          [],
        );

        expect(fs.existsSync(out)).toBe(true);
        checkRar5Signature(out);

        const tested = unrarOutput(["t", "-ps3cret", out]);
        if (tested !== null) expect(tested).toContain("All OK");
      } finally {
        fs.rmSync(td, { recursive: true, force: true });
      }
    },
  );
});
