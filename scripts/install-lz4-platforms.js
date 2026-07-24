#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const VERSION = "2.9.1";
const PACKAGES = [
  "lz4-napi-linux-x64-gnu",
  "lz4-napi-linux-x64-musl",
  "lz4-napi-linux-arm64-gnu",
  "lz4-napi-linux-arm64-musl",
  "lz4-napi-linux-arm-gnueabihf",
  "lz4-napi-linux-s390x-gnu",
  "lz4-napi-linux-ppc64-gnu",
  "lz4-napi-linux-riscv64-gnu",
  "lz4-napi-darwin-x64",
  "lz4-napi-darwin-arm64",
  "lz4-napi-win32-x64-msvc",
  "lz4-napi-win32-arm64-msvc",
  "lz4-napi-win32-ia32-msvc",
  "lz4-napi-android-arm64",
  "lz4-napi-android-arm-eabi",
  "lz4-napi-freebsd-x64",
  "lz4-napi-openharmony-arm64",
];

const destBase = path.join(__dirname, "..", "node_modules", "@antoniomuso");
fs.mkdirSync(destBase, { recursive: true });

for (const pkg of PACKAGES) {
  const scope = "@antoniomuso";
  const fullName = `${scope}/${pkg}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lz4-"));
  const packDir = path.join(tmpDir, "pack");
  fs.mkdirSync(packDir);

  console.log(`Downloading ${fullName}...`);
  try {
    execSync(`npm pack "${fullName}@${VERSION}" --pack-destination "${packDir}" --silent`, {
      stdio: "pipe",
    });
    const tgz = fs.readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("No tarball found");

    const pkgDir = path.join(destBase, pkg);
    fs.rmSync(pkgDir, { recursive: true, force: true });
    fs.mkdirSync(pkgDir, { recursive: true });

    execSync(`tar xzf "${path.join(packDir, tgz)}" -C "${pkgDir}" --strip-components=1`, {
      stdio: "pipe",
    });
    console.log(`  OK`);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const nodeFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".node")) nodeFiles.push(full);
  }
}
walk(destBase);

const totalSize = nodeFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`\n=== Installed ${nodeFiles.length} platform binaries (${(totalSize / 1024 / 1024).toFixed(1)} MB) ===`);
for (const f of nodeFiles) {
  console.log(`  ${(fs.statSync(f).size / 1024).toFixed(0)}K  ${path.relative(destBase, f)}`);
}
