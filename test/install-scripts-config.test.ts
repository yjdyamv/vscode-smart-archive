/**
 * Config sanity for the installer scripts: every staged target must have a
 * pinned SHA-256, hashes must be well-formed, and the two 7-Zip installers
 * must share the same release tag (via scripts/lib/releases.js).
 */
import { describe, it, expect } from "vitest";
import {
  EXPECTED_HASHES as H7Z,
  REPO as REPO7Z,
  TAG as TAG7Z,
  TARGETS,
} from "../scripts/install-7z-platforms.mjs";
import {
  EXPECTED_HASHES as HWASM,
  FILES,
  REPO as REPOWASM,
  TAG as TAGWASM,
} from "../scripts/install-7zz-wasm.mjs";
import {
  EXPECTED_HASHES as HSN,
  PACKAGES,
  WASM_ASSETS,
} from "../scripts/install-snappy-platforms.mjs";
import {
  SEVEN_ZIP_ZSTD_REPO,
  SEVEN_ZIP_ZSTD_TAG,
  SEVEN_ZIP_ZSTD_WASM_REPO,
} from "../scripts/lib/releases.mjs";

const HASH_RE = /^[0-9a-f]{64}$/;
const PLATFORMS = ["linux", "darwin", "win32"];
const ARCHES = ["x64", "arm64", "ia32", "arm"];

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
});

describe("7zz-wasm installer config", () => {
  it("pins exactly the staged files", () => {
    expect(Object.keys(HWASM).sort()).toEqual([...FILES].sort());
  });

  it("hashes are 64-char lowercase hex", () => {
    for (const [file, hash] of Object.entries(HWASM)) {
      expect(hash, `hash for ${file}`).toMatch(HASH_RE);
    }
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

describe("shared release constants", () => {
  it("both 7-Zip installers use the shared tag and repos", () => {
    expect(TAG7Z).toBe(SEVEN_ZIP_ZSTD_TAG);
    expect(TAGWASM).toBe(SEVEN_ZIP_ZSTD_TAG);
    expect(REPO7Z).toBe(SEVEN_ZIP_ZSTD_REPO);
    expect(REPOWASM).toBe(SEVEN_ZIP_ZSTD_WASM_REPO);
  });
});
