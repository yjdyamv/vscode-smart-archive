#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import { fetchReleaseAsset } from "./lib/github.mjs";
import { downloadWithCache, countStatuses } from "./lib/download.mjs";
import { writeFileAtomic } from "./lib/fs.mjs";
import { persistBootstrapHash } from "./lib/hash-pins.mjs";
import { mapLimit } from "./lib/async.mjs";
import { pathToFileURL } from "node:url";
/**
 * Stage the rar5 native binding (smart-archive-rar, napi-rs) under
 * vendor/rar5-bin/
 * for all desktop platforms, so the extension can create RAR5 archives
 * without any external binary.
 *
 * Modes:
 *
 *   1. Dev mode  — SA_RAR5_DEV=1 copies the locally built .node files from
 *      the binding project (default ~/桌面/smart-archive-rar). Use after:
 *        cd ~/桌面/smart-archive-rar && npm install && npx napi build --platform --release
 *
 *   2. Release mode (default) — downloads smart-archive-rar.<triple>.node from
 *      the binding's GitHub Release assets
 *      (https://github.com/yjdyamv/smart-archive-rar/releases), pinned against
 *      a SHA-256 hash (fail-closed). Set SA_RAR5_REQUIRE=1 for a fail-closed
 *      release build where every platform must stage.
 *
 * The loader (src/engines/rar5-engine.ts) resolves
 * vendor/rar5-bin/<platform>/<arch>/smart-archive-rar.<triple>.node
 *
 * Version policy: the release version is PINNED in-repo
 * (scripts/lib/releases.mjs — RAR5_VERSION), because the pinned hashes below
 * are bound to one specific release. Resolving "latest release" at install
 * time would make every new upstream release break fresh installs and CI
 * builds (fail-closed hash mismatch) until the pins are regenerated. To
 * update the binding: bump RAR5_VERSION, then run
 *   SA_HASH_BOOTSTRAP=1 node scripts/install-rar5-platforms.mjs
 * SA_RAR5_VERSION still overrides the pinned version for one-off experiments.
 */

// Binding repo, overridable (e.g. a fork):
//   SA_RAR5_REPO=me/smart-archive-rar
import { RAR5_REPO, RAR5_VERSION } from "./lib/releases.mjs";
const REPO = process.env.SA_RAR5_REPO || RAR5_REPO;

async function resolveVersion() {
  if (process.env.SA_RAR5_VERSION) return process.env.SA_RAR5_VERSION.replace(/^v/, "");
  return RAR5_VERSION;
}

// SHA-256 of each platform .node release asset plus the WASI fallback bundle
// (smart-archive-rar 0.3.1: append/delete/repair/rebuild operations,
// relocated recovery repair, WASI win32 path mapping); fail-closed. Verify
// against the official GitHub digest (SA_VERIFY_RAR5_HASHES=1 npm test)
// after a new release, then regenerate here (bootstrap prints and persists):
//   SA_HASH_BOOTSTRAP=1 node scripts/install-rar5-platforms.mjs
const EXPECTED_HASHES = {
  "linux-x64-gnu": "6bf53686f9d9bdb3a6e6bd440c570a6df463f48c630cddfb2b56dbec2c2b3587",
  "linux-x64-musl": "b973cf4c4a3474c10529ec8aa4b5b5c160b5752f3802b89569bccbeb40d962d8",
  "linux-arm64-gnu": "f47ce2f3e5f11b30e458b44fd2d065122404f934f486cccfcfa00854bf979555",
  "linux-arm64-musl": "652b7685b04a08773106793174370331685e56908935726a42eb2f009597a85d",
  "linux-arm-gnueabihf": "459fe607b03fa451173cc789faffc3f576de702c00f0b1c87ae01484e0c7286e",
  "darwin-arm64": "4f59827a7cfb0b60d356736f6f18bda12df0391c9f65fb5b79170e1c1daa1654",
  "win32-x64-msvc": "eaebecb3842433332b24aaee530f011c123cfcf784699bfcaff4c0360f47bf6d",
  "win32-ia32-msvc": "03d539634bcd42497f5f467a0f5b4bdfcb96ca46e19829e7732b24cbfde71c27",
  "win32-arm64-msvc": "be5daaa2a9eb0923fbe54122d3f3d254ab274c16121345f855673198c906dbf1",
  // WASI fallback bundle (smart-archive-rar >= 0.3.0), staged under
  // vendor/rar5-wasm/. Placeholder pins are regenerated with
  // SA_HASH_BOOTSTRAP=1 once the release assets exist.
  "smart-archive-rar.wasm32-wasi.wasm":
    "3b427abbd854d26c2a4eeead093674c17fc83ff6d97b5135459fd0e4896bbfd8",
  "smart-archive-rar.wasi.cjs": "0e71c3b9eab238c5a8018cd36a14acaf2a6ff6fd658d9db6a047cdf1164fd0bb",
  "wasi-path-map.cjs": "ca428d68155e0f2f2dc051d5ee32ac700b7644c02005ccfcffdf2b89f20f56be",
  "wasi-worker.mjs": "04baa257151d017504cebc916d439001edfaf9e0f3e84619790ecaf010fa68c7",
};

// <platform>/<arch> -> napi-rs triples
const TRIPLES = {
  "linux/x64": ["linux-x64-gnu", "linux-x64-musl"],
  "linux/arm64": ["linux-arm64-gnu", "linux-arm64-musl"],
  "linux/arm": ["linux-arm-gnueabihf"],
  "darwin/arm64": ["darwin-arm64"],
  "win32/x64": ["win32-x64-msvc"],
  "win32/ia32": ["win32-ia32-msvc"],
  "win32/arm64": ["win32-arm64-msvc"],
};

// WASI fallback bundle (smart-archive-rar >= 0.3.0): generated Node loader +
// release WASM module + threads worker. Staged to vendor/rar5-wasm/ so
// src/engines/rar5-engine.ts can require the loader when no native .node
// matches the host. The `.debug.wasm` variant is deliberately not staged:
// the napi loader prefers it whenever it exists, which would make
// production run the debug build.
const WASM_ASSETS = [
  "smart-archive-rar.wasm32-wasi.wasm",
  "smart-archive-rar.wasi.cjs",
  "wasi-path-map.cjs",
  "wasi-worker.mjs",
];
const wasmDestDir = path.join(import.meta.dirname, "..", "vendor", "rar5-wasm");

function devProject() {
  return process.env.SA_RAR5_PROJECT || path.join(os.homedir(), "桌面", "smart-archive-rar");
}

const destDir = path.join(import.meta.dirname, "..", "vendor", "rar5-bin");
const cacheDir = path.join(import.meta.dirname, "..", ".cache", "rar5-platforms");
fs.mkdirSync(cacheDir, { recursive: true });

function stageNode(nodeData, triple) {
  const found = Object.entries(TRIPLES).find(([, triples]) => triples.includes(triple));
  if (!found) throw new Error(`unknown triple: ${triple}`);
  const [platform, arch] = found[0].split("/");
  const destPath = path.join(destDir, platform, arch, `smart-archive-rar.${triple}.node`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileAtomic(destPath, nodeData);
  console.log(`  staged ${triple} -> vendor/rar5-bin/${platform}/${arch}/`);
}

function devMode() {
  const project = devProject();
  const candidates = [
    project, // napi build --platform copies the addon to the project root
    path.join(project, "target", "release"),
  ];
  let buildDir;
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.readdirSync(c).some((f) => f.endsWith(".node"))) {
      buildDir = c;
      break;
    }
  }
  if (!buildDir) {
    throw new Error(
      `no built .node found in ${project} — run 'npx napi build --platform --release' there`,
    );
  }
  const files = fs.readdirSync(buildDir).filter((f) => f.endsWith(".node"));
  for (const f of files) {
    const triple = f.replace(/^smart-archive-rar\./, "").replace(/\.node$/, "");
    stageNode(fs.readFileSync(path.join(buildDir, f)), triple);
  }
  for (const name of WASM_ASSETS) {
    const src = path.join(project, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(wasmDestDir, { recursive: true });
    writeFileAtomic(path.join(wasmDestDir, name), fs.readFileSync(src));
    console.log(`  staged ${name} -> vendor/rar5-wasm/`);
  }
}

async function stageWasmAssets(strict) {
  const statuses = [];
  for (const name of WASM_ASSETS) {
    console.log(`[rar5 ${name}]`);
    const hash = EXPECTED_HASHES[name];
    if (!hash && !process.env.SA_HASH_BOOTSTRAP) {
      if (strict) {
        throw new Error(
          `no pinned SHA-256 for ${name} — add it to EXPECTED_HASHES after releasing, ` +
            `or use SA_RAR5_DEV=1 for local builds`,
        );
      }
      console.warn(
        `  no pinned SHA-256 for ${name} — skipping (run SA_HASH_BOOTSTRAP=1 after releasing)`,
      );
      statuses.push("skipped");
      continue;
    }

    const bootstrapping = process.env.SA_HASH_BOOTSTRAP === "1";
    const destPath = path.join(wasmDestDir, name);
    const result = await downloadWithCache({
      cacheDir,
      cacheKey: `${resolvedVersion}/${name}`,
      destPath,
      expectedSha256: bootstrapping ? undefined : hash,
      requireHash: bootstrapping || strict,
      label: `rar5 ${name}`,
      fetch: () =>
        fetchReleaseAsset({
          repo: REPO,
          tag: `v${resolvedVersion}`,
          assetName: name,
          expectedSha256: bootstrapping ? undefined : hash,
        }),
    });

    if (result.status === "skipped") {
      console.log("  skipped (already staged)");
      statuses.push("skipped");
    } else if (result.status === "cached") {
      console.log("  from cache");
      statuses.push("cached");
    } else if (result.status === "downloaded") {
      console.log("  downloaded + cached");
      persistBootstrapHash(import.meta.filename, destPath, name);
      statuses.push("downloaded");
    } else if (strict) {
      console.error("  FAILED");
      statuses.push("failed");
    } else {
      console.warn("  not available (release not published yet)");
      statuses.push("skipped");
    }
  }
  return statuses;
}

async function releaseMode(strict) {
  const platforms = process.env.SA_RAR5_PLATFORMS
    ? process.env.SA_RAR5_PLATFORMS.split(",").map((s) => s.trim())
    : Object.keys(TRIPLES);
  const jobs = [];
  for (const key of platforms) {
    const [platform, arch] = key.split("/");
    const triples = TRIPLES[key] || [];
    for (const triple of triples) {
      jobs.push({
        key,
        platform,
        arch,
        triple,
        nodeFileName: `smart-archive-rar.${triple}.node`,
        destPath: path.join(destDir, platform, arch, `smart-archive-rar.${triple}.node`),
        hash: EXPECTED_HASHES[triple],
      });
    }
  }

  // Download concurrently (bounded) — 10 platform assets staged in ~one
  // round-trip instead of ten sequential downloads.
  const CONCURRENCY = 5;
  const nativeStatuses = await mapLimit(jobs, CONCURRENCY, async (job) => {
    console.log(`[rar5 ${job.triple}]`);
    if (!job.hash && !process.env.SA_HASH_BOOTSTRAP) {
      if (strict) {
        throw new Error(
          `no pinned SHA-256 for ${job.triple} — add it to EXPECTED_HASHES after releasing, ` +
            `or use SA_RAR5_DEV=1 for local builds`,
        );
      }
      console.warn(
        `  no pinned SHA-256 for ${job.triple} — skipping (run SA_HASH_BOOTSTRAP=1 after releasing)`,
      );
      return "skipped";
    }

    const bootstrapping = process.env.SA_HASH_BOOTSTRAP === "1";
    const result = await downloadWithCache({
      cacheDir,
      // Version-scoped key: a release bump must never reuse bytes cached for
      // an older release (the pinned hash would reject them anyway, but the
      // key keeps the cache honest and avoids repeated failed downloads).
      cacheKey: `${resolvedVersion}/${job.nodeFileName}`,
      destPath: job.destPath,
      // Bootstrap: no pin yet — download and print the new hash so it can
      // be pasted into EXPECTED_HASHES. Otherwise the stale pin would
      // reject the freshly released binaries.
      expectedSha256: bootstrapping ? undefined : job.hash,
      requireHash: bootstrapping || strict,
      label: `rar5 ${job.triple}`,
      fetch: async () => {
        // Shared GitHub fetch: direct first, then assets API, then mirrors.
        // SHA-256 pinning below keeps the fail-closed guarantee regardless
        // of the source.
        return fetchReleaseAsset({
          repo: REPO,
          tag: `v${resolvedVersion}`,
          assetName: job.nodeFileName,
          expectedSha256: bootstrapping ? undefined : job.hash,
        });
      },
    });

    if (result.status === "skipped") {
      console.log("  skipped (already staged)");
      return "skipped";
    }
    if (result.status === "cached") {
      console.log("  from cache");
      return "cached";
    }
    if (result.status === "downloaded") {
      console.log("  downloaded + cached");
      persistBootstrapHash(import.meta.filename, job.destPath, job.triple);
      return "downloaded";
    }
    if (strict) {
      console.error("  FAILED");
      return "failed";
    }
    console.warn("  not available (release not published yet)");
    return "skipped";
  });
  const wasmStatuses = await stageWasmAssets(strict);
  const statuses = [...nativeStatuses, ...wasmStatuses];

  const { installed, cached, skipped, failed } = countStatuses(statuses);
  console.log(
    `rar5: ${installed} installed, ${cached} from cache, ${skipped} skipped, ${failed} failed`,
  );
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  if (process.env.SA_RAR5_DEV) {
    devMode();
    return;
  }

  // Version resolution: SA_RAR5_VERSION (one-off override) > in-repo pin
  // (scripts/lib/releases.mjs RAR5_VERSION — the single source of truth).
  const version = await resolveVersion();
  resolvedVersion = version;
  releaseBase =
    process.env.SA_RAR5_RELEASE_BASE || `https://github.com/${REPO}/releases/download/v${version}`;
  console.log(`rar5: resolving bindings from ${releaseBase}`);

  if (process.env.SA_RAR5_REQUIRE === "1") {
    // Fail-closed release build: every platform must be staged.
    await releaseMode(true);
    return;
  }
  // Local-first default: stage whatever local builds exist (dev ergonomics),
  // otherwise fall back to release downloads. Releases must use
  // SA_RAR5_REQUIRE=1.
  try {
    devMode();
    const staged = fs.readdirSync(destDir, { recursive: true }).filter((f) => f.endsWith(".node"));
    console.log(`rar5: staged ${staged.length} local .node(s)`);
    if (staged.length < 9) {
      console.warn(
        `WARNING: only ${staged.length}/9 platforms staged from local build. ` +
          "Set SA_RAR5_REQUIRE=1 for a fail-closed release build, or wait for the " +
          "GitHub Release (then run SA_HASH_BOOTSTRAP=1 once).",
      );
    }
  } catch {
    await releaseMode(false);
  }
}

let releaseBase = "";
let resolvedVersion = "";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}

const getReleaseBase = () => releaseBase;

export { REPO, resolveVersion, getReleaseBase, TRIPLES, WASM_ASSETS, EXPECTED_HASHES, devProject };
