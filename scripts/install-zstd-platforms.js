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
  `https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}/zstd-napi-v${VERSION}-napi-v8-${p}.tar.gz`;
// SHA-256 of each platform's binding.node, verified on download (fail-closed).
// This map MUST be populated before release: with requireHash the build refuses
// any binary lacking a pinned hash. To (re)generate after a zstd-napi bump, run
// once and paste the printed values keyed by "<platform>-<arch>":
//   SA_HASH_BOOTSTRAP=1 node scripts/install-zstd-platforms.js
const EXPECTED_HASHES = {
  "linux-x64": "26acf4b6b8c0cf0f3bc5752d24b15b0c82568609f9d977daa973a47a859203b8",
  "linux-arm64": "44151cdbe0584ed38ff7735a80c42242842bd16cc254247c3ac862e54d58bf27",
  "linux-arm": "d414bd8ff48b88a8a1d09b829f849c0de05a6840df543a0b3a06a4c23cfea85a",
  "darwin-x64": "e8abcb6d98cf38fef7052053b6f2bb526a76be71cdd292ce2b5e88401086b9ba",
  "darwin-arm64": "13ca3d1c9017040af51b75b0c9272cc2c211afeb36a9f6299016603469afbda6",
  "win32-x64": "b2d170f79eb368e2eff89626d27a2872217d17de889cf4baae1299a470003cbe",
  "win32-ia32": "03258d0e2350d2be5c546852b8532a8f298335475081e0371349b49906847f8f",
};

const PLATFORMS = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["linux", "arm"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["win32", "x64"],
  ["win32", "ia32"],
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

  const nodeFiles = [];
  for (const [platform, arch] of PLATFORMS) {
    const f = path.join(destDir, `${platform}-${arch}`, "binding.node");
    if (fs.existsSync(f)) nodeFiles.push(f);
  }

  console.log(
    `\n=== ${nodeFiles.length} platform binaries | ${installed} downloaded, ${cached} cached, ${skipped} skipped, ${failed} failed ===`,
  );
  for (const f of nodeFiles) {
    const size = fs.statSync(f).size;
    const platformDir = path.basename(path.dirname(f));
    console.log(`  ${(size / 1024).toFixed(0)}K  ${platformDir}/binding.node`);
  }

  if (failed > 0) {
    console.error("\nERROR: cannot produce a complete cross-platform package.");
    process.exit(1);
  }

  const bindingJs = path.join(__dirname, "..", "node_modules", "zstd-napi", "binding.js");
  const loaderContent = `const fs = require("fs");
const path = require("path");

const buildType =
  process.config.target_defaults?.default_configuration ?? "Release";

const archMap = { x64: "x64", arm64: "arm64", arm: "arm", ia32: "ia32" };
const mappedArch = archMap[process.arch] || process.arch;
const platformKey = \`\${process.platform}-\${mappedArch}\`;

const platformPath = path.join(__dirname, "build", buildType, platformKey, "binding.node");
const defaultPath = path.join(__dirname, "build", buildType, "binding.node");

if (fs.existsSync(platformPath)) {
  module.exports = require(platformPath);
} else if (fs.existsSync(defaultPath)) {
  module.exports = require(defaultPath);
} else {
  throw new Error(
    \`zstd-napi native binding not found for platform \${platformKey}\`,
  );
}
`;
  fs.writeFileSync(bindingJs, loaderContent);
  console.log("\nUpdated binding.js with platform-aware loader");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
