#!/usr/bin/env node
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function getZstdMeta() {
  const pkgPath = path.join(__dirname, "..", "node_modules", "zstd-napi", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return { version: pkg.version };
}

const { version: VERSION } = getZstdMeta();
const SOURCES = [
  (p) => `https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}/zstd-napi-v${VERSION}-napi-v8-${p}.tar.gz`,
  (p) => `https://gh-proxy.com/https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}/zstd-napi-v${VERSION}-napi-v8-${p}.tar.gz`,
  (p) => `https://ghproxy.net/https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}/zstd-napi-v${VERSION}-napi-v8-${p}.tar.gz`,
];

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
const skipVerify = process.argv.includes("--skip-verify");

fs.mkdirSync(destDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

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
  const targetDir = path.join(destDir, platformKey);
  const expectedFile = path.join(targetDir, "binding.node");
  const cachedFile = path.join(cacheDir, platformKey, "binding.node");
  const cachedHash = cachedFile + ".sha256";

  if (fs.existsSync(expectedFile)) return { status: "skipped" };

  if (fs.existsSync(cachedFile)) {
    if (!skipVerify && fs.existsSync(cachedHash)) {
      const expected = fs.readFileSync(cachedHash, "utf8").trim();
      const actual = sha256(fs.readFileSync(cachedFile));
      if (expected === actual) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(cachedFile, expectedFile);
        return { status: "cached" };
      }
      console.error(`  ! cache hash mismatch for ${platformKey}, re-downloading`);
    } else {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(cachedFile, expectedFile);
      return { status: "cached" };
    }
  }

  for (const urlFn of SOURCES) {
    const url = urlFn(platformKey);
    try {
      const compressed = await httpGet(url);
      const decompressed = zlib.gunzipSync(compressed);
      const fileData = extractTarFile(decompressed, "build/Release/binding.node");
      if (!fileData) throw new Error("binding.node not found in tarball");
      const hash = sha256(fileData);

      fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
      fs.writeFileSync(cachedFile, fileData);
      fs.writeFileSync(cachedHash, hash + "\n");

      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(cachedFile, expectedFile);
      return { status: "downloaded" };
    } catch (err) {
      // Try next mirror
    }
  }

  return { status: "failed" };
}

async function main() {
  let installed = 0;
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const [platform, arch] of PLATFORMS) {
    const platformKey = `${platform}-${arch}`;
    console.log(`[${platformKey}]`);

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
