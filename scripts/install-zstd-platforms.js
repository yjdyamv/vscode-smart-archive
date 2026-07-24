#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function getZstdMeta() {
  const pkgPath = path.join(__dirname, "..", "node_modules", "zstd-napi", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return { version: pkg.version, binaryName: pkg.name || "zstd-napi" };
}

const { version: VERSION } = getZstdMeta();
const BASE_URLS = [
  `https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}`,
  `https://gh-proxy.com/https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}`,
  `https://ghproxy.net/https://github.com/drakedevel/zstd-napi/releases/download/v${VERSION}`,
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

function downloadUrl(url, targetDir) {
  try {
    execSync(
      `curl -sL --connect-timeout 5 --max-time 20 -H "User-Agent: node" "${url}" | tar xz -C "${targetDir}" --strip-components=2 "build/Release/binding.node"`,
      { stdio: "pipe", timeout: 25000 },
    );
    return true;
  } catch {
    return false;
  }
}

for (const [platform, arch] of PLATFORMS) {
  const platformKey = `${platform}-${arch}`;
  const targetDir = path.join(destDir, platformKey);
  const expectedFile = path.join(targetDir, "binding.node");

  if (fs.existsSync(expectedFile)) {
    console.log(`Skipping ${platformKey} (already installed)`);
    skipped++;
    continue;
  }

  console.log(`Downloading ${platformKey}...`);
  let success = false;

  for (const baseUrl of BASE_URLS) {
    const url = `${baseUrl}/zstd-napi-v${VERSION}-napi-v8-${platformKey}.tar.gz`;
    if (downloadUrl(url, targetDir)) {
      success = true;
      break;
    }
  }

  if (success) {
    console.log(`  OK`);
    installed++;
  } else {
    console.error(`  FAILED (all mirrors exhausted)`);
    fs.rmSync(targetDir, { recursive: true, force: true });
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
  `\n=== ${nodeFiles.length} platform binaries | ` +
    `${installed} installed, ${skipped} skipped, ${failed} failed ===`,
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
