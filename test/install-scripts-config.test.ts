/**
 * Config sanity for the engine dependencies: the download installer's pinned
 * hashes must be well-formed, and every npm-hosted engine (7-Zip ZS native,
 * 7-Zip ZS WASM, rar-rs) must be declared and installed with the files the
 * runtime actually loads.
 *
 * 7-Zip ZS native has no installer any more — it ships straight from
 * `node_modules/7zip-zstd-native` (bundled7z.ts resolves
 * bin/<platform>-<arch>/7zz) — so the declared/installed pair checks below
 * cover it, including the per-platform bins and the LGPL licence text.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  EXPECTED_HASHES as HSN,
  PACKAGES,
  WASM_ASSETS,
} from "../scripts/install-snappy-platforms.mjs";
import { binAllowlist, listPackageFiles, packageIgnoreDir } from "../scripts/lib/package-files.mjs";

const HASH_RE = /^[0-9a-f]{64}$/;
const ROOT = path.join(__dirname, "..");
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("snappy installer config", () => {
  it("pins exactly the staged packages and WASI assets", () => {
    expect(Object.keys(HSN).sort()).toEqual([...PACKAGES, ...WASM_ASSETS].sort());
  });

  it("hashes are 64-char lowercase hex", () => {
    for (const [pkg, hash] of Object.entries(HSN)) {
      expect(hash, `hash for ${pkg}`).toMatch(HASH_RE);
    }
  });
});

/**
 * The engines that used to be staged by hand are npm dependencies now. If one
 * is dropped from package.json its runtime loader fails at archive time (a
 * lazy require / spawn), so this pair of checks keeps the dependency and the
 * loader in sync before packaging does.
 */
describe("npm-hosted engines", () => {
  const declared = ROOT_PKG.dependencies ?? {};

  for (const pkg of ["7zip-zstd-native", "7zip-zstd-wasm", "@yjdyamv/rar-rs"]) {
    it(`${pkg} is a declared dependency and installed`, () => {
      expect(declared[pkg], `dependencies.${pkg}`).toBeTruthy();
      const installed = path.join(ROOT, "node_modules", ...pkg.split("/"), "package.json");
      expect(fs.existsSync(installed), `installed at ${installed}`).toBe(true);
    });
  }

  it("7zip-zstd-native ships a native 7zz for every desktop target", () => {
    const dir = path.join(ROOT, "node_modules", "7zip-zstd-native");
    // bundled7z.ts resolves bin/<process.platform>-<process.arch>/7zz(.exe).
    // The universal .vsix re-includes the whole package, so all six must exist.
    const expected = [
      "bin/linux-x64/7zz",
      "bin/linux-arm64/7zz",
      "bin/darwin-arm64/7zz",
      "bin/darwin-x64/7zz",
      "bin/win32-x64/7zz.exe",
      "bin/win32-arm64/7zz.exe",
    ];
    const files = listPackageFiles(dir);
    for (const rel of expected) {
      expect(files, `missing ${rel}`).toContain(rel);
    }
    // The LGPL licence text of the bundled binary ships with the package.
    expect(files).toContain("COPYING");
  });

  it("rar-rs ships the native bindings and the WASI bundle the loader requires", () => {
    const dir = path.join(ROOT, "node_modules", "@yjdyamv", "rar-rs");
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith("rar-rs-napi.") && f.endsWith(".node"))).toBe(true);
    expect(files).toContain("rar-rs-napi.wasi.cjs");
    expect(files).toContain("rar-rs-napi.wasm32-wasi.wasm");
  });

  it("7zip-zstd-wasm ships the CJS factory the loader requires", () => {
    const dir = path.join(ROOT, "node_modules", "7zip-zstd-wasm");
    expect(fs.readdirSync(dir)).toEqual(expect.arrayContaining(["7zz.cjs", "7zz.wasm"]));
  });
});

describe("package-files helpers", () => {
  it("packageIgnoreDir keeps the node_modules-relative path", () => {
    const dir = path.join(ROOT, "node_modules", "@yjdyamv", "rar-rs");
    expect(packageIgnoreDir(dir)).toBe("node_modules/@yjdyamv/rar-rs");
  });

  it("lists package files as posix-relative paths", () => {
    const dir = path.join(ROOT, "node_modules", "7zip-zstd-wasm");
    const files = listPackageFiles(dir);
    expect(files).toContain("7zz.cjs");
    for (const f of files) expect(f).not.toContain("\\");
  });

  it("binAllowlist keeps only the requested platform bin dir", () => {
    const dir = path.join(ROOT, "node_modules", "7zip-zstd-native");
    const lines = binAllowlist(dir, ["linux-x64"]);
    expect(lines).toContain("!node_modules/7zip-zstd-native/bin/linux-x64/7zz");
    // other platforms' bins are never re-included (a later exclusion cannot
    // undo a re-include, so they must simply never appear)
    expect(lines.some((l) => l.includes("/bin/win32-x64/"))).toBe(false);
    expect(lines.some((l) => l.includes("/bin/darwin-x64/"))).toBe(false);
    // non-bin payload (licence, manifest) is always kept
    expect(lines).toContain("!node_modules/7zip-zstd-native/COPYING");
  });
});
