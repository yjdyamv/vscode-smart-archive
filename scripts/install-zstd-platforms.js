#!/usr/bin/env node
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { httpGet, downloadWithCache, sha256 } = require("./lib/download-cache");

function getZstdMeta() {
  const pkgPath = path.join(__dirname, "..", "node_modules", "zstd-napi", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return { version: pkg.version };
}

const { version: VERSION } = getZstdMeta();

const SOURCE = (p) =>
  `https://github.com/yjdyamv/zstd-napi/releases/download/v${VERSION}/zstd-napi-v${VERSION}-napi-v8-${p}.tar.gz`;

const ATTESTATION_URL = `https://github.com/yjdyamv/zstd-napi/releases/download/v${VERSION}/prebuilds.intoto.jsonl`;

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

async function fetchReleaseHashes() {
  const content = await httpGet(ATTESTATION_URL);
  const tarballHashes = {};
  for (const line of content.toString("utf8").trim().split("\n")) {
    const obj = JSON.parse(line);
    const envelope = obj.dsseEnvelope;
    if (!envelope) continue;
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    for (const subject of payload.subject || []) {
      const name = subject.name;
      const match = name.match(/napi-v8-(.+)\.tar\.gz$/);
      if (match) {
        tarballHashes[match[1]] = subject.digest.sha256;
      }
    }
  }
  return tarballHashes;
}

async function resolvePlatform(platformKey, expectedTarballHash) {
  const destPath = path.join(destDir, platformKey, "binding.node");

  return downloadWithCache({
    cacheDir,
    cacheKey: path.join(platformKey, expectedTarballHash, "binding.node"),
    destPath,
    expectedSha256: undefined,
    requireHash: false,
    label: `zstd-napi ${platformKey}`,
    fetch: async () => {
      const url = SOURCE(platformKey);
      const compressed = await httpGet(url);
      const actualHash = sha256(compressed);
      if (actualHash !== expectedTarballHash) {
        throw new Error(
          `SHA-256 mismatch for tarball: expected ${expectedTarballHash}, got ${actualHash}`,
        );
      }
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

  let releaseHashes;
  try {
    releaseHashes = await fetchReleaseHashes();
  } catch (err) {
    console.error(`ERROR: cannot fetch release attestation: ${err.message}`);
    process.exit(1);
  }

  for (const [platform, arch] of PLATFORMS) {
    const platformKey = `${platform}-${arch}`;
    const expectedTarballHash = releaseHashes[platformKey];
    if (!expectedTarballHash) {
      console.error(`  SKIPPED (no attestation hash for ${platformKey})`);
      skipped++;
      continue;
    }

    console.log(`[zstd-napi ${platformKey}]`);

    const result = await resolvePlatform(platformKey, expectedTarballHash);
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
