/**
 * Config sanity for the engine dependencies: every staged target must have a
 * pinned SHA-256, hashes must be well-formed, and the remaining installer must
 * share its release tag with scripts/lib/releases.mjs.
 *
 * The WASM engines (7zip-zstd-wasm, @yjdyamv/rar-rs) have no installer — they
 * are npm dependencies — so they are covered by the declared/installed pair
 * checks below instead.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  EXPECTED_HASHES as H7Z,
  REPO as REPO7Z,
  TAG as TAG7Z,
  TARGETS,
} from "../scripts/install-7z-platforms.mjs";
import {
  EXPECTED_HASHES as HSN,
  PACKAGES,
  WASM_ASSETS,
} from "../scripts/install-snappy-platforms.mjs";
import { SEVEN_ZIP_ZSTD_REPO, SEVEN_ZIP_ZSTD_TAG } from "../scripts/lib/releases.mjs";
import { listPackageFiles, packageIgnoreDir } from "../scripts/lib/package-files.mjs";

const HASH_RE = /^[0-9a-f]{64}$/;
const PLATFORMS = ["linux", "darwin", "win32"];
const ARCHES = ["x64", "arm64", "arm"];
const ROOT = path.join(__dirname, "..");
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("7z native installer config", () => {
  it("pins exactly the staged assets", () => {
    const assets = TARGETS.map((t) => t.asset).sort();
    expect(Object.keys(H7Z).sort()).toEqual(assets);
  });

  it("hashes are 64-char lowercase hex", () => {
    for (const [asset, hash] of Object.entries(H7Z)) {
      expect(hash, `hash for ${asset}`).toMatch(HASH_RE);
    }
  });

  it("targets are well-formed", () => {
    for (const t of TARGETS) {
      expect(["tgz", "zip"], `kind for ${t.asset}`).toContain(t.kind);
      expect(t.dests.length, `dests for ${t.asset}`).toBeGreaterThan(0);
      expect(Object.keys(t.pick).length, `pick for ${t.asset}`).toBeGreaterThan(0);
      for (const [platform, arch] of t.dests) {
        expect(PLATFORMS, `platform for ${t.asset}`).toContain(platform);
        expect(ARCHES, `arch for ${t.asset}`).toContain(arch);
      }
    }
  });

  it("has no duplicate destination dirs", () => {
    const seen = new Set<string>();
    for (const t of TARGETS) {
      for (const [platform, arch] of t.dests) {
        const key = `${platform}/${arch}`;
        expect(seen.has(key), `duplicate dest ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("uses the shared release tag and repo", () => {
    expect(TAG7Z).toBe(SEVEN_ZIP_ZSTD_TAG);
    expect(REPO7Z).toBe(SEVEN_ZIP_ZSTD_REPO);
  });
});

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
 * is dropped from package.json the runtime loader fails at archive time (a
 * lazy require), so this pair of checks keeps the dependency and the loader
 * in sync before packaging does.
 */
describe("npm-hosted engines", () => {
  const declared = ROOT_PKG.dependencies ?? {};

  for (const pkg of ["7zip-zstd-wasm", "@yjdyamv/rar-rs"]) {
    it(`${pkg} is a declared dependency and installed`, () => {
      expect(declared[pkg], `dependencies.${pkg}`).toBeTruthy();
      const installed = path.join(ROOT, "node_modules", ...pkg.split("/"), "package.json");
      expect(fs.existsSync(installed), `installed at ${installed}`).toBe(true);
    });
  }

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
});
