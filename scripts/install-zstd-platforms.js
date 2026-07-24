#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const VERSION = "0.0.13";
const NAPI_VER = "v8";
const BASE_URL = `https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}`;

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

for (const [platform, arch] of PLATFORMS) {
  const platformKey = `${platform}-${arch}`;
  const tarballName = `zstd-napi-v${VERSION}-napi-${NAPI_VER}-${platformKey}.tar.gz`;
  const url = `${BASE_URL}/${tarballName}`;
  const targetDir = path.join(destDir, platformKey);
  fs.mkdirSync(targetDir, { recursive: true });

  console.log(`Downloading ${platformKey}...`);
  try {
    execSync(
      `curl -sL -H "User-Agent: node" "${url}" | tar xz -C "${targetDir}" --strip-components=2 "build/Release/binding.node"`,
      { stdio: "pipe" },
    );
    console.log(`  OK`);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

const nodeFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === "binding.node") nodeFiles.push(full);
  }
}
walk(destDir);

console.log(`\n=== Downloaded ${nodeFiles.length} platform binaries ===`);
for (const f of nodeFiles) {
  const size = fs.statSync(f).size;
  const platformDir = path.basename(path.dirname(f));
  console.log(`  ${(size / 1024).toFixed(0)}K  ${platformDir}/binding.node`);
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
