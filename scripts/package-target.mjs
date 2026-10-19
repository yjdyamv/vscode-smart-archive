#!/usr/bin/env node
/**
 * Package per-target (platform-arch) builds — Smart Archiver
 *
 * The universal package ships every platform's binaries: `vendor/` alone is
 * ~43 MB (5 native 7zz + 8 rar5 bindings) and every `.node` snappy binding
 * weighs ~1 MB, so the single .vsix is ~27 MB compressed and each user pays
 * for four platforms they will never run. This script emits one .vsix per
 * VS Code target instead, letting the Marketplace serve the matching build.
 *
 *   node scripts/package-target.mjs                     # every target
 *   node scripts/package-target.mjs win32-x64 linux-x64 # just these
 *
 * Each package keeps the WASI/WASM fallbacks (vendor/7zz-wasm,
 * vendor/rar5-wasm, snappy's *.wasi + .wasm) — the runtime falls back to
 * them when the native binary fails to load, so a target build is a payload
 * trim, not a behaviour change. Only the per-platform native files differ.
 *
 * darwin-x64 gets no native binaries on purpose: there is no prebuilt 7zz
 * or rar5 binding for Intel macOS (scripts/install-7z-platforms.mjs), so
 * that target ships the WASM engines — slower, but it is exactly what the
 * universal package does on the same machine today.
 *
 * Implementation note: `.vscodeignore` cannot narrow the blanket
 * `!node_modules/snappy/**` re-include — vsce applies re-includes last, so a
 * later exclusion for an unwanted `*.node` is silently ignored (verified by
 * packaging with such an exclusion in place: all 9 bindings still shipped).
 * The snappy allowlist is therefore *generated* from the installed package
 * tree with only the `.node` files filtered, so a dependency bump that adds
 * a file cannot break `require("snappy")` the way the hand-written list did
 * in 2.6.3.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignorePath = path.join(root, ".vscodeignore");
const backupPath = path.join(os.tmpdir(), `vscodeignore-bak-targets-${process.pid}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const snappyDir = path.join(root, "node_modules", "snappy");

/**
 * Native files per VS Code target. `sevenZip` and `rar5` are the
 * `vendor/<name>/<platform>/<arch>` directories to keep; `snappy` lists the
 * binding suffixes that may be kept. `null` = no prebuilt natives exist, so
 * the package is WASM-only.
 *
 * Linux keeps both the gnu and the musl binding: VS Code has one linux-x64
 * target and Alpine hosts install that same package.
 */
const TARGETS = {
  "win32-x64": {
    sevenZip: ["win32", "x64"],
    rar5: ["win32", "x64"],
    snappy: ["win32-x64-msvc"],
  },
  "win32-arm64": {
    sevenZip: ["win32", "arm64"],
    rar5: ["win32", "arm64"],
    snappy: ["win32-arm64-msvc"],
  },
  "linux-x64": {
    sevenZip: ["linux", "x64"],
    rar5: ["linux", "x64"],
    snappy: ["linux-x64-gnu", "linux-x64-musl"],
  },
  "linux-arm64": {
    sevenZip: ["linux", "arm64"],
    rar5: ["linux", "arm64"],
    snappy: ["linux-arm64-gnu", "linux-arm64-musl"],
  },
  "darwin-arm64": {
    sevenZip: ["darwin", "arm64"],
    rar5: ["darwin", "arm64"],
    snappy: ["darwin-arm64"],
  },
  "darwin-x64": null,
};

/** Every file under node_modules/snappy, as posix-relative paths. */
function listSnappyFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(snappyDir, full).split(path.sep).join("/"));
    }
  };
  walk(snappyDir);
  return out.sort();
}

/**
 * Per-file re-includes for the snappy package, minus the bindings that do
 * not apply to this target. WASI files (.wasi.cjs, .wasm, wasi-worker.mjs)
 * are never filtered — they are the fallback.
 */
function snappyAllowlist(target) {
  const keep = target ? target.snappy : [];
  return listSnappyFiles()
    .filter((rel) => {
      if (!rel.endsWith(".node")) return true;
      const suffix = rel.replace(/^snappy\./, "").replace(/\.node$/, "");
      return keep.includes(suffix);
    })
    .map((rel) => `!node_modules/snappy/${rel}`);
}

function buildTargetIgnore(original, target) {
  // darwin-x64 has no prebuilt natives: every vendor/** subtree is excluded.
  const keep = target ?? { sevenZip: [null, null], rar5: [null, null] };
  const lines = original
    .split("\n")
    // Superseded by the generated allowlist below.
    .filter((l) => l.trim() !== "!node_modules/snappy/**")
    .filter((l) => l.trim() !== "node_modules/snappy/snappy.win32-ia32-msvc.node");

  const excludes = ["", `# ── per-target build: ${targetLabel(target)} ──`];

  // Native 7-Zip / rar5 binaries and their licences. Excluding the parent
  // first and re-including one subtree works here: re-includes are applied
  // last (the same mechanism the existing node_modules rules rely on).
  for (const [name, [platform, arch]] of [
    ["7z-bin", keep.sevenZip],
    ["rar5-bin", keep.rar5],
  ]) {
    excludes.push(`vendor/${name}/**`);
    if (platform) excludes.push(`!vendor/${name}/${platform}/${arch}/**`);
  }
  excludes.push("!vendor/7z-bin/License.txt", "!vendor/7z-bin/VERSION-native");

  return (
    lines.join("\n") + "\n" + excludes.join("\n") + "\n" + snappyAllowlist(target).join("\n") + "\n"
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
