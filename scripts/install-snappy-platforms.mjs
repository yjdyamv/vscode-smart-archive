#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import zlib from "zlib";
import fs from "fs";
import path from "path";
import { httpGet, httpGetJson } from "./lib/http.mjs";
import { extractNodeFromTgz, extractFileFromTgz } from "./lib/archive.mjs";
import { downloadWithCache, countStatuses } from "./lib/download.mjs";
import { persistBootstrapHash, sha256 } from "./lib/hash-pins.mjs";
import { writeFileAtomic } from "./lib/fs.mjs";
/**
 * Stage platform-specific snappy native binaries plus the official
 * wasm32-wasip1-threads WASI bundle for all desktop platforms so the
 * extension can bundle them cross-platform (the WASM 7zz engine remains
 * the universal fallback for non-wrapped formats, but tar.sz requires the
 * snappy binding for both create and extract).
 *
 * The snappy npm package (napi-rs, github.com/Brooooooklyn/snappy) ships
 * platform binaries as @napi-rs/snappy-<triple> optional dependencies.
 * This script downloads each desktop-platform tarball from the npm registry,
 * extracts the snappy.<triple>.node file, pins it against a SHA-256 hash
 * (fail-closed), and places it into node_modules/snappy/ so the napi-rs
 * loader finds it on every platform. snappy >= 7.3.1 ships a WASI fallback
 * (@napi-rs/snappy-wasm32-wasi) for hosts without a native binary; its
 * loader + wasm files are staged alongside the natives.
 *
 * To (re)generate hashes after a snappy version bump, run once:
 *   SA_HASH_BOOTSTRAP=1 node scripts/install-snappy-platforms.mjs
 * The script prints the new hashes and persists them into EXPECTED_HASHES.
 */

function getSnappyVersion() {
  const pkgPath = path.join(import.meta.dirname, "..", "node_modules", "snappy", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

const VERSION = getSnappyVersion();

const PACKAGES = [
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-arm-gnueabihf",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64-msvc",
  "win32-arm64-msvc",
];

// WASI fallback bundle from @napi-rs/snappy-wasm32-wasi (same version as the
// snappy package). Staged into node_modules/snappy/ so the generated loader's
// `require("./snappy.wasi.cjs")` fallback resolves on every host.
const WASM_ASSETS = ["snappy.wasi.cjs", "snappy.wasm32-wasi.wasm", "wasi-worker.mjs"];

// SHA-256 of each platform's .node binary, verified on download.
// This map MUST be populated before release: with requireHash the build
// refuses any binary lacking a pinned hash. To (re)generate after bump:
//   SA_HASH_BOOTSTRAP=1 node scripts/install-snappy-platforms.mjs
const EXPECTED_HASHES = {
  "linux-x64-gnu": "dbb886eaa194ed6acc961afe8f37a6079d91c4d36f0ccdbc1ade0dd3a24c357d",
  "linux-x64-musl": "c3ff155cd6d07f68f5216f58641d12a7ee1bd5c3ec1f2e55519fa9f99c77f9c5",
  "linux-arm64-gnu": "df4ef575e78e4aeccf42f4024196e50864089102a8d589e3f6ce6f3d40f5e960",
  "linux-arm64-musl": "fdd2c1f61da4832a99356a1316ac432a291711c95b8cf53c1c23852395a62cc3",
  "linux-arm-gnueabihf": "eaed46c603ddc2cbde69c1c07e727ab0bc60701c6d70ccda7d838dc596b3371e",
  "darwin-x64": "1f68d4c9079017dd4a74509baf70c252781a2475dfb18d91edf0236cb7cf9000",
  "darwin-arm64": "a878e1708a61966cf09f9ebe37296aa6c340882d82c42a825705edc3cb418f41",
  "win32-x64-msvc": "2df0aae3495dd633084b8076cb68ff2e9def9cbab965f4689ab9de9b0210b659",
  "win32-arm64-msvc": "e4120c5c2e8cd82422bc866fa5700182245ad11f3e1456d091b2dfd31458468c",
  // WASI fallback bundle (snappy >= 7.3.1). Placeholder pins are regenerated
  // with SA_HASH_BOOTSTRAP=1 after the dependency bump.
  "snappy.wasi.cjs": "2adcd6dbf79398edcdf5a741d8bd37d3d1b6e8be032f32dc28aa4e1a6f45db91",
  "snappy.wasm32-wasi.wasm": "846c8dd07b4e7c12397b8c6a65109e41b32f375be7add8a9121f0744f80d89ac",
  "wasi-worker.mjs": "f1a1a998d9d253108e44a5ecff3d1eff27d38d1de02f1772ce3d37473dbc4b35",
};

const destDir = path.join(import.meta.dirname, "..", "node_modules", "snappy");
const cacheDir = path.join(import.meta.dirname, "..", ".cache", "snappy-platforms");

fs.mkdirSync(destDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

async function resolvePackage(pkg) {
  const nodeFileName = `snappy.${pkg}.node`;
  const destPath = path.join(destDir, nodeFileName);
  const npmName = `@napi-rs/snappy-${pkg}`;

  const result = await downloadWithCache({
    cacheDir,
    // Version-scoped key: a snappy bump must never reuse binaries cached for
    // an older release (the pinned hash would reject them anyway, but the
    // key keeps the cache honest and avoids repeated failed downloads).
    cacheKey: `${VERSION}/${nodeFileName}`,
    destPath,
    expectedSha256: EXPECTED_HASHES[pkg],
    requireHash: true,
    label: `snappy ${pkg}`,
    fetch: async () => {
      const metaUrl = `https://registry.npmjs.org/${npmName}/${VERSION}`;
      const meta = await httpGetJson(metaUrl);
      const tarballUrl = meta.dist && meta.dist.tarball;
      if (!tarballUrl) throw new Error(`no tarball URL in ${npmName} metadata`);

      const tgz = await httpGet(tarballUrl);
      const decompressed = zlib.gunzipSync(tgz);
      const nodeData = extractNodeFromTgz(decompressed);
      if (!nodeData) throw new Error(`.node file not found in ${npmName} tarball`);
      return nodeData;
    },
  });

  if (result.status === "downloaded") {
    persistBootstrapHash(import.meta.filename, destPath, pkg);
  }

  return result;
}

async function stageWasmAssets() {
  const npmName = "@napi-rs/snappy-wasm32-wasi";
  const metaUrl = `https://registry.npmjs.org/${npmName}/${VERSION}`;
  const meta = await httpGetJson(metaUrl);
  const tarballUrl = meta.dist && meta.dist.tarball;
  if (!tarballUrl) throw new Error(`no tarball URL in ${npmName} metadata`);

  const tgz = await httpGet(tarballUrl);
  const decompressed = zlib.gunzipSync(tgz);
  const statuses = [];

  for (const name of WASM_ASSETS) {
    const destPath = path.join(destDir, name);
    const bootstrapping = process.env.SA_HASH_BOOTSTRAP === "1";
    if (
      !bootstrapping &&
      fs.existsSync(destPath) &&
      sha256(fs.readFileSync(destPath)) === EXPECTED_HASHES[name]
    ) {
      console.log(`  ${name} already staged`);
      statuses.push("skipped");
      continue;
    }
    const data = extractFileFromTgz(decompressed, (entry) => entry === `package/${name}`);
    if (!data) throw new Error(`${name} not found in ${npmName} tarball`);

    const actual = sha256(data);
    if (!bootstrapping && EXPECTED_HASHES[name] !== actual) {
      throw new Error(
        `SHA-256 mismatch for snappy wasm ${name}: ` +
          `expected ${EXPECTED_HASHES[name]}, got ${actual}`,
      );
    }
    writeFileAtomic(destPath, data);
    console.log(`  staged ${name} -> node_modules/snappy/`);
    if (bootstrapping) persistBootstrapHash(import.meta.filename, destPath, name);
    statuses.push("downloaded");
  }

  return statuses;
}

async function main() {
  const statuses = [];

  for (const pkg of PACKAGES) {
    console.log(`[snappy ${pkg}]`);
    const result = await resolvePackage(pkg);

    if (result.status === "skipped") {
      console.log("  skipped (already installed)");
    } else if (result.status === "cached") {
      console.log("  from cache");
    } else if (result.status === "downloaded") {
      console.log("  downloaded + cached");
    } else {
      console.error("  FAILED");
    }
    statuses.push(result.status);
  }

  const wasmStatuses = await stageWasmAssets();
  statuses.push(...wasmStatuses);

  const { installed, cached, skipped, failed } = countStatuses(statuses);

  const nodeFiles = [];
  for (const pkg of PACKAGES) {
    const f = path.join(destDir, `snappy.${pkg}.node`);
    if (fs.existsSync(f)) nodeFiles.push(f);
  }

  const totalSize = nodeFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
  console.log(
    `\n=== ${nodeFiles.length} platform binaries (${(totalSize / 1024 / 1024).toFixed(1)} MB) | ` +
      `${installed} downloaded, ${cached} cached, ${skipped} skipped, ${failed} failed ===`,
  );
  for (const f of nodeFiles) {
    const name = path.basename(f);
    console.log(`  ${(fs.statSync(f).size / 1024).toFixed(0)}K  ${name}`);
  }
  for (const name of WASM_ASSETS) {
    const f = path.join(destDir, name);
    if (fs.existsSync(f)) {
      console.log(`  ${(fs.statSync(f).size / 1024).toFixed(0)}K  ${name}`);
    }
  }

  if (failed > 0) {
    console.error("\nERROR: cannot produce a complete cross-platform package.");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { PACKAGES, WASM_ASSETS, EXPECTED_HASHES, getSnappyVersion };
