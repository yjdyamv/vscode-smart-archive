#!/usr/bin/env node
/**
 * Package per-target (platform-arch) builds — Smart Archiver
 *
 * The universal package ships every platform's binaries: `vendor/` alone is
 * ~19 MB (5 native 7zz) and the `@yjdyamv/rar-rs` dependency adds 9 rar5
 * bindings (~26 MB with the WASI bundle), while every `.node` snappy binding
 * weighs ~1 MB, so the single .vsix is ~27 MB compressed and each user pays
 * for four platforms they will never run. This script emits one .vsix per
 * VS Code target instead, letting the Marketplace serve the matching build.
 *
 *   node scripts/package-target.mjs                     # every target
 *   node scripts/package-target.mjs win32-x64 linux-x64 # just these
 *
 * Each package keeps the WASI/WASM fallbacks (7zip-zstd-wasm,
 * @yjdyamv/rar-rs's rar-rs-napi.wasi.cjs, snappy's *.wasi + .wasm) — the
 * runtime falls back to them when the native binary fails to load, so a
 * target build is a payload trim, not a behaviour change. Only the
 * per-platform native files differ.
 *
 * darwin-x64 gets no native binaries on purpose: there is no prebuilt 7zz
 * for Intel macOS (scripts/install-7z-platforms.mjs) and `@yjdyamv/rar-rs`
 * ships no darwin-x64 binding, so that target ships the WASM engines —
 * slower, but it is exactly what the universal package does on the same
 * machine today.
 *
 * Implementation note: `.vscodeignore` cannot narrow the blanket
 * `!node_modules/snappy/**` / `!node_modules/@yjdyamv/rar-rs/**` re-includes
 * — vsce applies re-includes last, so a later exclusion for an unwanted
 * `*.node` is silently ignored (verified by packaging with such an
 * exclusion in place: all 9 bindings still shipped). Both allowlists are
 * therefore *generated* from the installed package tree with only the
 * `.node` files filtered, so a dependency bump that adds a file cannot break
 * `require("snappy")` the way the hand-written list did in 2.6.3.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindingAllowlist } from "./lib/package-files.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignorePath = path.join(root, ".vscodeignore");
const backupPath = path.join(os.tmpdir(), `vscodeignore-bak-targets-${process.pid}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const snappyDir = path.join(root, "node_modules", "snappy");
const rarRsDir = path.join(root, "node_modules", "@yjdyamv", "rar-rs");

/**
 * Native files per VS Code target. `sevenZip` is the
 * `vendor/<name>/<platform>/<arch>` directory to keep; `rar5` and `snappy`
 * list the binding triples/suffixes that may be kept. `null` = no prebuilt
 * natives exist, so the package is WASM-only.
 *
 * Linux keeps both the gnu and the musl binding: VS Code has one linux-x64
 * target and Alpine hosts install that same package.
 */
const TARGETS = {
  "win32-x64": {
    sevenZip: ["win32", "x64"],
    rar5: ["win32-x64-msvc"],
    snappy: ["win32-x64-msvc"],
  },
  "win32-arm64": {
    sevenZip: ["win32", "arm64"],
    rar5: ["win32-arm64-msvc"],
    snappy: ["win32-arm64-msvc"],
  },
  "linux-x64": {
    sevenZip: ["linux", "x64"],
    rar5: ["linux-x64-gnu", "linux-x64-musl"],
    snappy: ["linux-x64-gnu", "linux-x64-musl"],
  },
  "linux-arm64": {
    sevenZip: ["linux", "arm64"],
    rar5: ["linux-arm64-gnu", "linux-arm64-musl"],
    snappy: ["linux-arm64-gnu", "linux-arm64-musl"],
  },
  "darwin-arm64": {
    sevenZip: ["darwin", "arm64"],
    rar5: ["darwin-arm64"],
    snappy: ["darwin-arm64"],
  },
  "darwin-x64": null,
};

/** `vendor/<name>/<platform>/<arch>` plus the two licence files. */
function sevenZipExcludes(target) {
  const [platform, arch] = target?.sevenZip ?? [null, null];
  const lines = ["vendor/7z-bin/**"];
  if (platform) lines.push(`!vendor/7z-bin/${platform}/${arch}/**`);
  lines.push("!vendor/7z-bin/License.txt", "!vendor/7z-bin/VERSION-native");
  return lines;
}

function buildTargetIgnore(original, target) {
  // darwin-x64 has no prebuilt natives: every vendor/** subtree is excluded
  // and both binding allowlists keep only their WASI/WASM files.
  const keep = target ?? { sevenZip: [null, null], rar5: [], snappy: [] };
  const lines = original
    .split("\n")
    // Superseded by the generated allowlists below.
    .filter((l) => l.trim() !== "!node_modules/snappy/**")
    .filter((l) => l.trim() !== "!node_modules/@yjdyamv/rar-rs/**")
    .filter((l) => l.trim() !== "node_modules/snappy/snappy.win32-ia32-msvc.node");

  const excludes = [
    "",
    `# ── per-target build: ${targetLabel(target)} ──`,
    ...sevenZipExcludes(target),
  ];

  return (
    lines.join("\n") +
    "\n" +
    excludes.join("\n") +
    "\n" +
    bindingAllowlist(snappyDir, /^snappy\./, keep.snappy).join("\n") +
    "\n" +
    bindingAllowlist(rarRsDir, /^rar-rs-napi\./, keep.rar5).join("\n") +
    "\n"
  );
}

function targetLabel(target) {
  if (!target) return "WASM-only (no prebuilt natives)";
  return `${target.sevenZip[0]}/${target.sevenZip[1]}`;
}

const requested = process.argv.slice(2);
const unknown = requested.filter((t) => !(t in TARGETS));
if (unknown.length > 0) {
  console.error(`unknown target(s): ${unknown.join(", ")}`);
  console.error(`known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
const targets = requested.length > 0 ? requested : Object.keys(TARGETS);

// `npm run package:targets` starts with `npm ci`, which wipes the staged
// snappy prebuilds out of node_modules. vsce's vscode:prepublish hook
// re-stages them, but only *after* this script has generated the allowlists
// from the tree — the first target then shipped no native snappy binding
// (observed while verifying 2.8.1: win32-x64 16 files, no .node). Stage up
// front so both allowlists describe the tree that is actually packaged.
// Idempotent, and a no-op without network when everything is already there.
execFileSync(process.execPath, [path.join(root, "scripts", "install-snappy-platforms.mjs")], {
  stdio: "inherit",
});

const original = fs.readFileSync(ignorePath, "utf8");
fs.copyFileSync(ignorePath, backupPath);
const produced = [];
try {
  for (const name of targets) {
    const target = TARGETS[name];
    fs.writeFileSync(ignorePath, buildTargetIgnore(original, target));
    const out = path.join(root, `smart-archiver-${pkg.version}-${name}.vsix`);
    console.log(`\n▶ ${name} — ${targetLabel(target)}`);
    execFileSync("npx", ["vsce", "package", "--target", name, "-o", out], {
      cwd: root,
      stdio: "inherit",
    });
    produced.push([name, out, fs.statSync(out).size]);
  }
} finally {
  fs.copyFileSync(backupPath, ignorePath);
  fs.rmSync(backupPath, { force: true });
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log("\nper-target packages:");
for (const [name, out, size] of produced)
  console.log(`  ${name.padEnd(14)} ${mb(size).padStart(8)}  ${path.basename(out)}`);
