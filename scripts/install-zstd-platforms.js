#!/usr/bin/env node
const https = require("https");
const zlib = require("zlib");
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
fs.mkdirSync(destDir, { recursive: true });

let installed = 0;
let skipped = 0;
let failed = 0;

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

function extractTarFile(tarBuf, targetPath, tarPath) {
  // Parse GNU tar to extract a single file.
  // Format: 512-byte header block, then file data padded to 512.
  const BLOCK = 512;
  let pos = 0;
  const strippedPath = tarPath.startsWith("./") ? tarPath.slice(2) : tarPath;
  const targetPrefix = "build/Release/";

  while (pos + BLOCK <= tarBuf.length) {
    const header = tarBuf.subarray(pos, pos + BLOCK);

    // Check for end-of-archive (two zero blocks)
    if (header.every((b) => b === 0)) break;

    // Read name (100 bytes at offset 0)
    let nameEnd = header.indexOf(0, 0);
    if (nameEnd < 0 || nameEnd > 100) nameEnd = 100;
    const name = header.subarray(0, nameEnd).toString("utf8");

    // Read type flag
    const typeFlag = String.fromCharCode(header[156]);
    const isLongName = typeFlag === "L" || typeFlag === "K";
    const isDir = typeFlag === "5";

    // Read size (12 bytes at offset 124, octal)
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;

    pos += BLOCK;

    if (isLongName) {
      // Read the long name block
      const longName = tarBuf.subarray(pos, pos + size).toString("utf8").replace(/\0/g, "");
      pos += Math.ceil(size / BLOCK) * BLOCK;
      // The next header will use this name
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

async function downloadPlatform(platformKey) {
  const targetDir = path.join(destDir, platformKey);
  const expectedFile = path.join(targetDir, "binding.node");

  if (fs.existsSync(expectedFile)) return "skipped";

  for (const urlFn of SOURCES) {
    const url = urlFn(platformKey);
    try {
      const compressed = await httpGet(url);
      const decompressed = zlib.gunzipSync(compressed);
      const fileData = extractTarFile(decompressed, expectedFile, "build/Release/binding.node");
      if (!fileData) throw new Error("binding.node not found in tarball");

      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(expectedFile, fileData);
      return "installed";
    } catch (err) {
      // Try next mirror
    }
  }
  return "failed";
}

async function main() {
  for (const [platform, arch] of PLATFORMS) {
    const platformKey = `${platform}-${arch}`;
    const existingFile = path.join(destDir, platformKey, "binding.node");

    if (fs.existsSync(existingFile)) {
      console.log(`Skipping ${platformKey} (already installed)`);
      skipped++;
      continue;
    }

    console.log(`Downloading ${platformKey}...`);
    const result = await downloadPlatform(platformKey);
    if (result === "installed") {
      console.log("  OK");
      installed++;
    } else {
      console.error("  FAILED (all mirrors exhausted)");
      failed++;
    }
  }

  const nodeFiles = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "binding.node") nodeFiles.push(full);
    }
  }
  walk(destDir);

  console.log(
    `\n=== ${nodeFiles.length} platform binaries | ${installed} installed, ${skipped} skipped, ${failed} failed ===`,
  );
  for (const f of nodeFiles) {
    const size = fs.statSync(f).size;
    const platformDir = path.basename(path.dirname(f));
    console.log(`  ${(size / 1024).toFixed(0)}K  ${platformDir}/binding.node`);
  }

  if (failed > 0) {
    console.error(`\nWARNING: ${failed} platform(s) failed to download.`);
  }

  // Replace binding.js with platform-aware loader
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

main().catch(console.error);
