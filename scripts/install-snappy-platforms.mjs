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
  "linux-x64-gnu": "6d4de54bb2233e2199abe0e8fd299f01436501d135afe09b6ff50b0fdf184fa3",
  "linux-x64-musl": "cce9e75e7cef317db6b9870a523cb46bcb744816c6300ab79040e1fec35dd775",
  "linux-arm64-gnu": "c8b9330b842422d9e895ca6358c481b023afe69943c0e5ed8f31321eae78d71c",
  "linux-arm64-musl": "4b661cc383e60b0f5a517a4dbb4bd7bf5150db540c4f727dbc4010c115632296",
  "linux-arm-gnueabihf": "380c14efda6b0eebdf7ddabdfc6cdcf0bf1022267c5ff7fec04968b5b9b7d639",
  "darwin-x64": "34eb09686d42246fec0772954eb7aaf438fdcf94e6ec27cd3f6a5d2aee6cc839",
  "darwin-arm64": "4df10dd30850e04d02663729aa177153ee3c8546e8bb701bb0e324a5d51c42cb",
  "win32-x64-msvc": "b9870a043571b729b7e6b945f7dee2359aa028c45a2be7b5bcd66546814aac8b",
  "win32-arm64-msvc": "77c28362232d0b59696c632b6ef95c270dfe79504a603694752390196c61c028",
  // WASI fallback bundle (snappy >= 7.3.1). Placeholder pins are regenerated
  // with SA_HASH_BOOTSTRAP=1 after the dependency bump.
  "snappy.wasi.cjs": "c99c41f788cf56647b138fdbd85d7ec9e9108af22a2ce72861552e59089657ed",
  "snappy.wasm32-wasi.wasm": "fb82aad244bf89464fd2b57606efaa2a345fb3467c2db41498ecdcaad5653c47",
  "wasi-worker.mjs": "fcba42b35462dc3f402b9626d8a2f30e9e7f73e9783e41d74c0003e02adc6ca1",
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
