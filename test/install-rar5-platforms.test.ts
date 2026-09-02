/**
 * rar5 install integrity tests — Smart Archiver
 *
 * Three layers of protection around scripts/install-rar5-platforms.js:
 *   1. config sanity: every staged triple has a pinned SHA-256, in valid form;
 *   2. staged binaries: any .node already staged under vendor/rar5-bin/ must match
 *      its pinned hash (or be byte-identical to a local dev build);
 *   3. official digest (optional): with SA_VERIFY_RAR5_HASHES=1, compares
 *      EXPECTED_HASHES against the GitHub Release API's `digest` field —
 *      the authoritative source that the pins really match the released
 *      assets (run after each new release; skipped in CI to avoid rate
 *      limits).
 *
 * @module test/install-rar5-platforms
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_HASHES,
  TRIPLES,
  WASM_ASSETS,
  REPO,
  resolveVersion,
} from "../scripts/install-rar5-platforms.mjs";

const HASH_RE = /^[0-9a-f]{64}$/;

function allTriples(): string[] {
  return Object.values(TRIPLES).flat();
}

function stagedNodes(): { triple: string; file: string }[] {
  const root = path.join(__dirname, "..", "vendor", "rar5-bin");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true })
    .filter((f) => typeof f === "string" && f.endsWith(".node"))
    .map((f) => ({
      triple: path.basename(f as string, ".node").replace(/^rar-rs-napi\./, ""),
      file: path.join(root, f as string),
    }));
}

describe("rar5 platform config", () => {
  it("pins every native triple and WASI asset", () => {
    const pinned = Object.keys(EXPECTED_HASHES).sort();
    expect(pinned).toEqual([...allTriples(), ...WASM_ASSETS].sort());
  });

  it("hashes are 64-char lowercase hex", () => {
    for (const [triple, hash] of Object.entries(EXPECTED_HASHES)) {
      expect(hash, `hash for ${triple}`).toMatch(HASH_RE);
    }
  });

  it("staged rar5-bin binaries match their pinned hashes", () => {
    const staged = stagedNodes();
    if (staged.length === 0) return; // clean checkout / CI without stage:natives

    // devMode (SA_RAR5_DEV) deliberately stages locally built addons whose
    // hashes differ from the CI-built release assets — allowed when
    // byte-identical to the local dev build. Anything else that deviates
    // from the pinned hash fails the packaging gate.
    const devProject =
      process.env.SA_RAR5_DEV_PROJECT ?? path.join(os.homedir(), "桌面", "rar-rs", "crates", "rar-napi");
    for (const { triple, file } of staged) {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (actual === EXPECTED_HASHES[triple]) continue;
      const devFile = path.join(devProject, `rar-rs-napi.${triple}.node`);
      const devHash =
        fs.existsSync(devFile) && fs.statSync(devFile).isFile()
          ? crypto.createHash("sha256").update(fs.readFileSync(devFile)).digest("hex")
          : undefined;
      if (devHash !== actual) {
        throw new Error(
          `SHA-256 mismatch for staged ${triple}: pinned=${EXPECTED_HASHES[triple]} ` +
            `actual=${actual}`,
        );
      }
    }
  });
});

describe("rar5 release digest verification", () => {
  it("pinned hashes match the official GitHub Release digest", async () => {
    if (process.env.SA_VERIFY_RAR5_HASHES !== "1") return;

    // Same resolution the install script uses, so the pin is checked against
    // the version that would actually be staged.
    const version = await resolveVersion();
    const url = `https://api.github.com/repos/${REPO}/releases/tags/v${version}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "smart-archiver" },
    });
    expect(res.ok, `GitHub API ${res.status} — run with SA_VERIFY_RAR5_HASHES=1 manually`).toBe(
      true,
    );
    const data = (await res.json()) as {
      assets?: { name: string; digest?: string }[];
    };
    const digestByAsset = new Map(
      (data.assets ?? [])
        .filter((a) => a.digest)
        .map((a) => [a.name, a.digest!.replace(/^sha256:/, "")]),
    );

    const assets = [
      ...allTriples().map((triple) => ({
        asset: `rar-rs-napi.${triple}.node`,
        pinKey: triple,
      })),
      ...WASM_ASSETS.map((name) => ({ asset: name, pinKey: name })),
    ];
    for (const { asset, pinKey } of assets) {
      const official = digestByAsset.get(asset);
      expect(official, `no digest for ${asset} in release v${version}`).toBeTruthy();
      expect(EXPECTED_HASHES[pinKey], `pin for ${pinKey} differs from GitHub digest`).toBe(official);
    }
  });
});
