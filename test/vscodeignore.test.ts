/**
 * VSIX packaging whitelist tests — Smart Archiver VSCode Extension
 *
 * .vscodeignore excludes the whole node_modules tree and re-includes only
 * the packages the external runtime require chain needs. Regression: tslib
 * was missing, so RAR5 WASM compression failed in the installed extension
 * ("Cannot find module 'tslib'" from @tybys/wasm-util). Every module the
 * require chain touches must stay whitelisted.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ignore = readFileSync(resolve(__dirname, "../.vscodeignore"), "utf8");

const RUNTIME_REQUIRE_CHAIN = [
  "node_modules/@napi-rs/wasm-runtime",
  "node_modules/@emnapi",
  "node_modules/@tybys",
  "node_modules/tslib",
  "node_modules/snappy",
  "node_modules/@vscode/codicons",
];

describe(".vscodeignore runtime whitelist", () => {
  it("re-includes every module in the external runtime require chain", () => {
    for (const module of RUNTIME_REQUIRE_CHAIN) {
      expect(ignore, `missing whitelist entry for ${module}`).toContain(`!${module}`);
    }
  });

  it("still excludes the rest of node_modules", () => {
    expect(ignore).toContain("node_modules/");
  });
});
