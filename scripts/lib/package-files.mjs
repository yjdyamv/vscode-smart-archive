/**
 * `.vscodeignore` re-include generation for npm packages — Smart Archiver
 *
 * `.vscodeignore` re-includes cannot be undone by a later exclusion: vsce
 * applies the `!` rules last, so
 *
 *   !node_modules/snappy/**               (re-include the package)
 *   node_modules/snappy/snappy.win32-ia32-msvc.node   (drop one binding)
 *
 * still ships all nine bindings (verified by packaging). The only reliable
 * way to drop a file is to never re-include it, which means generating
 * per-file re-includes from the installed tree instead of writing them by
 * hand — the hand-written list broke `require("snappy")` in 2.6.3 when a
 * dependency bump added `stream-polyfill.*`.
 *
 * Both engines ship their native bindings flat in the package root under a
 * predictable prefix, so one generic rule covers them:
 *
 *   snappy    node_modules/snappy/snappy.<triple>.node
 *   rar-rs    node_modules/@yjdyamv/rar-rs/rar-rs-napi.<triple>.node
 *
 * Everything that is not a `.node` (JS entry chain, WASI loader + .wasm +
 * worker, licences, package.json) is always kept — that is the fallback the
 * runtime uses when no native binding matches the host.
 *
 * @module scripts/lib/package-files
 */

import fs from "node:fs";
import path from "node:path";

/** Every file under `dir`, as posix-relative paths (sorted for stable diffs). */
export function listPackageFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** `node_modules/<pkg>` for an installed package directory. */
export function packageIgnoreDir(pkgDir) {
  const marker = `node_modules${path.sep}`;
  const at = pkgDir.lastIndexOf(marker);
  if (at < 0) throw new Error(`not inside node_modules: ${pkgDir}`);
  return pkgDir.slice(at).split(path.sep).join("/");
}

/**
 * Per-file re-includes for one binding package, minus the bindings for
 * platforms this build does not target. `keep` holds binding triples
 * (`snappy.linux-x64-musl` → `linux-x64-musl`); an empty list keeps the WASI
 * files only, which is the pure-WASM build.
 */
export function bindingAllowlist(pkgDir, nodePrefix, keep) {
  const ignoreDir = packageIgnoreDir(pkgDir);
  return listPackageFiles(pkgDir)
    .filter((rel) => {
      if (!rel.endsWith(".node")) return true;
      const suffix = rel.replace(nodePrefix, "").replace(/\.node$/, "");
      return keep.includes(suffix);
    })
    .map((rel) => `!${ignoreDir}/${rel}`);
}

/**
 * Per-file re-includes for a package whose per-platform payload lives under
 * `bin/<dir>/…` (7zip-zstd-native: `bin/linux-x64/7zz`, …). Everything outside
 * `bin/` is always kept (the JS entry chain, the licence, the manifest); under
 * `bin/` only `keepDirs` are kept, so a per-target build never ships four
 * platforms it cannot run. An empty list keeps no native binary at all (the
 * pure-WASM build).
 */
export function binAllowlist(pkgDir, keepDirs) {
  const ignoreDir = packageIgnoreDir(pkgDir);
  return listPackageFiles(pkgDir)
    .filter((rel) => {
      const m = rel.match(/^bin\/([^/]+)\//);
      if (!m) return true; // not a per-platform payload — always keep
      return keepDirs.includes(m[1]);
    })
    .map((rel) => `!${ignoreDir}/${rel}`);
}
