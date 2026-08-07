/**
 * Snappy WASI (wasm32-wasip1-threads) fallback — Smart Archive
 *
 * snappy >= 7.3.1 ships an official WASI bundle (@napi-rs/snappy-wasm32-wasi);
 * scripts/install-snappy-platforms.js stages its loader + wasm next to the
 * native binaries in node_modules/snappy/. These tests exercise that loader
 * directly and through the upstream `require("snappy")` fallback
 * (NAPI_RS_FORCE_WASI=error), verifying the raw-block round trip used by
 * src/engines/snappy-codec.ts. Gated on the staged loader.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const LOADER = path.join(
  __dirname,
  "..",
  "node_modules",
  "snappy",
  "snappy.wasi.cjs",
);

interface SnappyLike {
  compressSync(data: Uint8Array): Buffer;
  uncompressSync(data: Uint8Array): Buffer;
}

function assertRoundTrip(snappy: SnappyLike): void {
  const data = Buffer.from("snappy wasm roundtrip ".repeat(200));
  const compressed = snappy.compressSync(data);
  expect(compressed.length).toBeGreaterThan(0);
  expect(compressed.length).toBeLessThan(data.length);
  const restored = snappy.uncompressSync(compressed);
  expect(Buffer.from(restored).equals(data)).toBe(true);
}

describe("snappy WASI fallback", () => {
  it.runIf(fs.existsSync(LOADER))(
    "round-trips raw blocks through the staged WASI loader",
    () => {
      assertRoundTrip(require(LOADER) as SnappyLike);
    },
  );

  it.runIf(fs.existsSync(LOADER))(
    "require('snappy') falls back to WASI when native is forced off",
    () => {
      const script = `
        const s = require("snappy");
        const data = Buffer.from("forced wasm ".repeat(128));
        const c = s.compressSync(data);
        const u = s.uncompressSync(c);
        if (!u.equals(data)) process.exit(1);
        console.log("snappy-wasm-ok");
      `;
      const out = execFileSync(process.execPath, ["-e", script], {
        env: { ...process.env, NAPI_RS_FORCE_WASI: "error" },
        encoding: "utf8",
      });
      expect(out).toContain("snappy-wasm-ok");
    },
  );
});
