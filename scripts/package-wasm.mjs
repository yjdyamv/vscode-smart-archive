#!/usr/bin/env node
/**
 * Package a pure-WASM build of the extension — Smart Archiver
 *
 * Produces smart-archiver-<version>-wasm.vsix containing only the WASM
 * engines (js7z 7-Zip, rar5 WASI, snappy/zstd/brotli/lz4 WASI codecs):
 * no native .node binaries, no 7zz executables. The extension already
 * falls back to these engines when the native binaries are absent, so
 * the packaged runtime is unchanged — only the payload differs.
 *
 *   node scripts/package-wasm.mjs
 *
 * Generates a wasm-only .vscodeignore for the packaging run: the
 * snappy *.node re-include is dropped (ignore rules cannot be undone by
 * a later exclusion — the re-include always wins) and the native
 * binary dirs are excluded. The original ignore list is restored
 * afterwards.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignorePath = path.join(root, ".vscodeignore");
const backupPath = path.join(os.tmpdir(), `vscodeignore-bak-${process.pid}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Native binaries excluded from the pure-WASM package. The WASI loaders
// (vendor/rar5-wasm, node_modules/snappy/*.wasi.*) and the WASM 7-Zip
// (vendor/7zz-wasm) stay — the runtime auto-falls back to them.
const WASM_ONLY_EXCLUDES = `# ── pure-WASM package: drop native binaries (engines fall back to WASI/WASM) ──
vendor/rar5-bin/**
vendor/7z-bin/**
`;

function buildWasmIgnore(original) {
  // The snappy *.node re-include would override any later exclusion, so
  // remove it for the wasm-only build (node_modules/ already excludes
  // everything not re-included).
  const lines = original
    .split("\n")
    .filter((l) => l.trim() !== "!node_modules/snappy/snappy.*.node");
  return lines.join("\n") + "\n" + WASM_ONLY_EXCLUDES;
}

fs.copyFileSync(ignorePath, backupPath);
try {
  fs.writeFileSync(ignorePath, buildWasmIgnore(fs.readFileSync(ignorePath, "utf8")));
  const out = path.join(root, `smart-archiver-${pkg.version}-wasm.vsix`);
  execFileSync("npx", ["vsce", "package", "-o", out], { cwd: root, stdio: "inherit" });
  console.log(`pure-WASM package: ${out}`);
} finally {
  fs.copyFileSync(backupPath, ignorePath);
  fs.rmSync(backupPath, { force: true });
}
