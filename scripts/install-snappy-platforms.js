#!/usr/bin/env node
/**
 * Stage platform-specific snappy native binaries for all desktop platforms so
 * the extension can bundle them cross-platform (the WASM 7zz engine remains
 * the universal fallback for non-wrapped formats, but tar.sz requires the
 * native snappy binding for both create and extract).
 *
 * The snappy npm package (napi-rs, github.com/Brooooooklyn/snappy) ships
 * platform binaries as @napi-rs/snappy-<triple> optional dependencies.
 * This script downloads each desktop-platform tarball from the npm registry,
 * extracts the snappy.<triple>.node file, pins it against a SHA-256 hash
 * (fail-closed), and places it into node_modules/snappy/ so the napi-rs
 * loader finds it on every platform.
 *
 * To (re)generate hashes after a snappy version bump, run once:
 *   SA_HASH_BOOTSTRAP=1 node scripts/install-snappy-platforms.js
 * then paste the printed values into EXPECTED_HASHES.
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const {
  httpGet,
  httpGetJson,
  downloadWithCache,
  extractNodeFromTgz,
} = require("./lib/download-cache");

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

// SHA-256 of each platform's .node binary, verified on download.
// This map MUST be populated before release: with requireHash the build
// refuses any binary lacking a pinned hash. To (re)generate after bump:
//   SA_HASH_BOOTSTRAP=1 node scripts/install-snappy-platforms.js
const EXPECTED_HASHES = {
  "linux-x64-gnu": "471852cb9874266f92ea1057efbab9894cec9d4773963363f8432d192b2472cd",
  "linux-x64-musl": "1591931d6d21132cb34c4062a842460b93cb6bd2b3cb3cd2bed5cc2549847201",
  "linux-arm64-gnu": "2e7c05f0cb6e92cc679a12d79d2a29c8049322b29aed8acf7f4e6dbad0a7cc6f",
  "linux-arm64-musl": "f52c1393622561d9ad20dc07f9ec85ea8f5da800830b37026da8bb80036f5db0",
  "linux-arm-gnueabihf": "4ab1928a3ca63437234619a8b63c7a2f9fc09d590aaa38ed4de450eb72078cd5",
  "darwin-x64": "daacd1eb396bb078bec5e964815383f41b822c7be602ebab370aff43d46cb5cf",
  "darwin-arm64": "847a2b3d75e58a9e8ff38915df1a94362ef35e96997eb957d57930a17658e787",
  "win32-x64-msvc": "7e8a01ec61e5c4bd7b20209c00247a65278c9b4b1672904b5f7580a9e48a502f",
  "win32-ia32-msvc": "e988f79652cc8db624bdc9319d929d0fd4dff186339a5d437ce1931cbd83b906",
  "win32-arm64-msvc": "8e365ceb479aaf5d2062d136f224405b8c45b65ea407ead6334bd62604d827ee",
};

const destDir = path.join(__dirname, "..", "node_modules", "snappy");
const cacheDir = path.join(__dirname, "..", ".cache", "snappy-platforms");

fs.mkdirSync(destDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

async function resolvePackage(pkg) {
  const nodeFileName = `snappy.${pkg}.node`;
  const destPath = path.join(destDir, nodeFileName);
  const npmName = `@napi-rs/snappy-${pkg}`;

  return downloadWithCache({
    cacheDir,
    cacheKey: nodeFileName,
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
}

async function main() {
  let installed = 0;
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const pkg of PACKAGES) {
    console.log(`[snappy ${pkg}]`);
    const result = await resolvePackage(pkg);

    if (result.status === "skipped") {
      console.log("  skipped (already installed)");
      skipped++;
    } else if (result.status === "cached") {
      console.log("  from cache");
      cached++;
    } else if (result.status === "downloaded") {
      console.log("  downloaded + cached");
      installed++;
    } else {
      console.error("  FAILED");
      failed++;
    }
  }

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

  if (failed > 0) {
    console.error("\nERROR: cannot produce a complete cross-platform package.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
