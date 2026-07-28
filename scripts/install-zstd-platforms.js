#!/usr/bin/env node
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { httpGet, downloadWithCache } = require("./lib/download-cache");

function getZstdMeta() {
  const pkgPath = path.join(__dirname, "..", "node_modules", "zstd-napi", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return { version: pkg.version };
}

const { version: VERSION } = getZstdMeta();

const SOURCE = (p) =>
  `https://github.com/yjdyamv/zstd-napi/releases/download/v${VERSION}/zstd-napi-v${VERSION}-napi-v8-${p}.tar.gz`;
// SHA-256 of each platform's binding.node, verified on download (fail-closed).
// This map MUST be populated before release: with requireHash the build refuses
// any binary lacking a pinned hash. To (re)generate after a zstd-napi bump, run
// once and paste the printed values keyed by "<platform>-<arch>":
//   SA_HASH_BOOTSTRAP=1 node scripts/install-zstd-platforms.js
const EXPECTED_HASHES = {
  "linux-x64": "e2703d8efd59cda7187375bf159edc7fcf19fb4a663d7b2de1985dd669ce6134",
  "linux-arm64": "c673f49c7547c566e1a5943980e0c264662d9b96c155472970dd7c6c78eac7dc",
  "linux-arm": "7b0cac4685d10536bdc589d0198a6d40e55aa8b61a2f52d83e42b32a7182c02b",
  "linux-x64-musl": "f42913e92cebd09f1f76aae4d065295baf2f1b3c675c268e3b8460939dbad1cd",
  "linux-arm64-musl": "140d3a59238986f5836192fe4b33dce2fbdfee04f66a3fd6b47664b3933c8cf5",
  "darwin-x64": "19209f1713dc57a00fc721a23207f126cb99777a75c10dfee1476817f7812b02",
  "darwin-arm64": "a96c8a42a5f2f400662961961dbb7369a9149ee61fd0960baf07be5a92c66133",
  "win32-x64": "60861434f92f2255222829c721232dbbb64b7e34c0f19cef88047904b02b8d34",
  "win32-ia32": "0b10cf3a6dd81e9b50f94347580da0abf2f432a374b61824d2dce4942f30a815",
  "win32-arm64": "170170104e1b5a292a0863af1f348f6f8fd75bb6ea7647087abfb23ddfa712fa",
};

const PLATFORMS = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["linux", "arm"],
  ["linux", "x64-musl"],
  ["linux", "arm64-musl"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["win32", "x64"],
  ["win32", "ia32"],
  ["win32", "arm64"],
];

const destDir = path.join(__dirname, "..", "node_modules", "zstd-napi", "build", "Release");
const cacheDir = path.join(__dirname, "..", ".cache", "zstd-platforms");

fs.mkdirSync(destDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

function extractTarFile(tarBuf, tarPath) {
  const BLOCK = 512;
  let pos = 0;
  const strippedPath = tarPath.startsWith("./") ? tarPath.slice(2) : tarPath;

  while (pos + BLOCK <= tarBuf.length) {
    const header = tarBuf.subarray(pos, pos + BLOCK);

    if (header.every((b) => b === 0)) break;

    let nameEnd = header.indexOf(0, 0);
    if (nameEnd < 0 || nameEnd > 100) nameEnd = 100;
    const name = header.subarray(0, nameEnd).toString("utf8");

    const typeFlag = String.fromCharCode(header[156]);
    const isLongName = typeFlag === "L" || typeFlag === "K";
    const isDir = typeFlag === "5";

    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;

    pos += BLOCK;

    if (isLongName) {
      pos += Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    const dataEnd = pos + Math.ceil(size / BLOCK) * BLOCK;

    if (!isDir && name === strippedPath) {
      return tarBuf.subarray(pos, pos + size);
    }

    pos = dataEnd;
  }
  return null;
}

async function resolvePlatform(platformKey) {
  const destPath = path.join(destDir, platformKey, "binding.node");

  return downloadWithCache({
    cacheDir,
    cacheKey: path.join(platformKey, "binding.node"),
    destPath,
    expectedSha256: EXPECTED_HASHES[platformKey],
    requireHash: true,
    label: `zstd-napi ${platformKey}`,
    fetch: async () => {
      const url = SOURCE(platformKey);
      const compressed = await httpGet(url);
      const decompressed = zlib.gunzipSync(compressed);
      const fileData = extractTarFile(decompressed, "build/Release/binding.node");
      if (!fileData) throw new Error("binding.node not found in tarball");
      return fileData;
    },
  });
}

async function main() {
  let installed = 0;
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const [platform, arch] of PLATFORMS) {
    const platformKey = `${platform}-${arch}`;
    console.log(`[zstd-napi ${platformKey}]`);

    const result = await resolvePlatform(platformKey);
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
      console.error("  FAILED (all mirrors exhausted)");
      failed++;
    }
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
