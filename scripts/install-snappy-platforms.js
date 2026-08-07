#!/usr/bin/env node
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
 *   SA_HASH_BOOTSTRAP=1 node scripts/install-snappy-platforms.js
 * The script prints the new hashes and persists them into EXPECTED_HASHES.
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { httpGet, httpGetJson } = require("./lib/http");
const { extractNodeFromTgz, extractFileFromTgz } = require("./lib/archive");
const { downloadWithCache, countStatuses } = require("./lib/download");
const { persistBootstrapHash, sha256 } = require("./lib/hash-pins");
const { writeFileAtomic } = require("./lib/fs");

function getSnappyVersion() {
  const pkgPath = path.join(__dirname, "..", "node_modules", "snappy", "package.json");
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
  "win32-ia32-msvc",
  "win32-arm64-msvc",
];

// WASI fallback bundle from @napi-rs/snappy-wasm32-wasi (same version as the
// snappy package). Staged into node_modules/snappy/ so the generated loader's
// `require("./snappy.wasi.cjs")` fallback resolves on every host.
const WASM_ASSETS = ["snappy.wasi.cjs", "snappy.wasm32-wasi.wasm", "wasi-worker.mjs"];

// SHA-256 of each platform's .node binary, verified on download.
// This map MUST be populated before release: with requireHash the build
// refuses any binary lacking a pinned hash. To (re)generate after bump:
//   SA_HASH_BOOTSTRAP=1 node scripts/install-snappy-platforms.js
const EXPECTED_HASHES = {
  "linux-x64-gnu": "42ac694666e35e21b96d09c374b89918acd7d95297d1adfd9d31edb4fb7a5ebb",
  "linux-x64-musl": "31eb00fd08d44f3379d51074159bae843ed94c84c2c83dc13612e3664627084e",
  "linux-arm64-gnu": "22cb9f72886e1b7c4f10f3c100a2e562c5dee01fa058469815496e45d5fe81d0",
  "linux-arm64-musl": "214cea9afd2fd8a3c7540788dd5c5f340a1ae459d1bf2fe2304b84e2898f2d26",
  "linux-arm-gnueabihf": "a6bcea8dfe4809e2a7760961645a019d200ac5b85ba10ce85725868f8e7502b9",
  "darwin-x64": "ac63599dc7036c83ebe616092f853b5b62945364c9023542f04a9807b6a6d9ff",
  "darwin-arm64": "d85eca57cc0d5005351a85e039e5c57feb5634acdcf61a0dd5b6876f827e36d9",
  "win32-x64-msvc": "325df83f5db9fc0bb39c2c0c96d396ed14e179cad3264ed823500cc930b4ae46",
  "win32-ia32-msvc": "bf33003c948b8aefbbe37f4d5d3ae17e01802ba5b44b1507317a60ac94c520d7",
  "win32-arm64-msvc": "bfb2bb77cee88f017f1d13477f684f829e38ec72d895f84bd5a733c4c8e864a6",
  // WASI fallback bundle (snappy >= 7.3.1). Placeholder pins are regenerated
  // with SA_HASH_BOOTSTRAP=1 after the dependency bump.
  "snappy.wasi.cjs": "149c80e8bb88083f9420c8e812f0fcdcb223d9095076202b3b18da0bd768c189",
  "snappy.wasm32-wasi.wasm": "00ea25a0484d5a28bee43ee603958c1ea2241ffaf5ccf269d57a02e8af8e08f6",
  "wasi-worker.mjs": "4c6ba7435bce4ae8bcfd02e10fc6ae09a97b71ec5269fe828eb521b07ab67c0c",
};

const destDir = path.join(__dirname, "..", "node_modules", "snappy");
const cacheDir = path.join(__dirname, "..", ".cache", "snappy-platforms");

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
    persistBootstrapHash(__filename, destPath, pkg);
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
    if (bootstrapping) persistBootstrapHash(__filename, destPath, name);
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  PACKAGES,
  WASM_ASSETS,
  EXPECTED_HASHES,
  getSnappyVersion,
};
