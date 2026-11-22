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
 * Generates a wasm-only .vscodeignore for the packaging run: the blanket
 * snappy/rar-rs/7zip-zstd-native package re-includes are replaced by generated
 * per-file re-includes that skip every `*.node` and every native 7zz (ignore
 * rules cannot be undone by a later exclusion — the re-include always wins).
 * The original ignore list is restored afterwards.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindingAllowlist } from "./lib/package-files.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignorePath = path.join(root, ".vscodeignore");
const backupPath = path.join(os.tmpdir(), `vscodeignore-bak-${process.pid}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** Re-includes that survive in the pure-WASM build: everything but natives. */
const KEPT_BINDINGS = [
  bindingAllowlist(path.join(root, "node_modules", "snappy"), /^snappy\./, []),
  bindingAllowlist(path.join(root, "node_modules", "@yjdyamv", "rar-rs"), /^rar-rs-napi\./, []),
].flat();

function buildWasmIgnore(original) {
  // The blanket package re-includes would override any later exclusion, so
  // they are dropped for the wasm-only build and replaced with the generated
  // per-file list above (which keeps the WASI loaders, .wasm modules, JS
  // entry chains and licences).
  const lines = original
    .split("\n")
    .filter((l) => l.trim() !== "!node_modules/snappy/**")
    .filter((l) => l.trim() !== "!node_modules/@yjdyamv/rar-rs/**")
    .filter((l) => l.trim() !== "!node_modules/7zip-zstd-native/**")
    .filter((l) => l.trim() !== "node_modules/snappy/snappy.win32-ia32-msvc.node");

  return (
    lines.join("\n") +
    "\n" +
    [
      "# ── pure-WASM package: drop native binaries (engines fall back to WASI/WASM) ──",
      ...KEPT_BINDINGS,
      "",
    ].join("\n")
  );
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
