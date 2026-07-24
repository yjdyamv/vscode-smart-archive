#!/usr/bin/env node
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function getLz4Version() {
  const pkgPath = path.join(__dirname, "..", "node_modules", "lz4-napi", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

const VERSION = getLz4Version();
const PACKAGES = [
  "lz4-napi-linux-x64-gnu",
  "lz4-napi-linux-x64-musl",
  "lz4-napi-linux-arm64-gnu",
  "lz4-napi-linux-arm64-musl",
  "lz4-napi-linux-arm-gnueabihf",
  "lz4-napi-darwin-x64",
  "lz4-napi-darwin-arm64",
  "lz4-napi-win32-x64-msvc",
  "lz4-napi-win32-arm64-msvc",
  "lz4-napi-win32-ia32-msvc",
];

const destBase = path.join(__dirname, "..", "node_modules", "@antoniomuso");
fs.mkdirSync(destBase, { recursive: true });

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

function getTarballUrl(pkgName) {
  const url = `https://registry.npmjs.org/@antoniomuso/${pkgName}/${VERSION}`;
  // npm returns the full package metadata JSON, we just need the tarball URL
  // which is at .dist.tarball
  return url;
}

async function httpGetJson(url) {
  const buf = await httpGet(url);
  return JSON.parse(buf.toString("utf8"));
}

function extractNodeFromTgz(tgzBuf) {
  const BLOCK = 512;
  let pos = 0;
  const buf = tgzBuf;

  while (pos + BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;

    let nameEnd = header.indexOf(0, 0);
    if (nameEnd < 0 || nameEnd > 100) nameEnd = 100;
    const name = header.subarray(0, nameEnd).toString("utf8");

    const typeFlag = String.fromCharCode(header[156]);
    const isDir = typeFlag === "5";
    const isLongName = typeFlag === "L" || typeFlag === "K";

    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;

    pos += BLOCK;

    if (isLongName) {
      pos += Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    const dataEnd = pos + Math.ceil(size / BLOCK) * BLOCK;

    if (!isDir && name.endsWith(".node")) {
      return buf.subarray(pos, pos + size);
    }

    pos = dataEnd;
  }
  return null;
}

async function installPackage(pkg) {
  const pkgDir = path.join(destBase, pkg);
  const dotNode = path.join(pkgDir, `lz4-napi.${pkg.replace("lz4-napi-", "")}.node`);

  if (fs.existsSync(dotNode)) return "skipped";

  try {
    // Get tarball URL from npm metadata
    const metaUrl = `https://registry.npmjs.org/@antoniomuso/${pkg}/${VERSION}`;
    const meta = await httpGetJson(metaUrl);
    const tarballUrl = meta.dist && meta.dist.tarball;
    if (!tarballUrl) throw new Error("no tarball URL in metadata");

    const tgz = await httpGet(tarballUrl);
    const decompressed = zlib.gunzipSync(tgz);
    const nodeData = extractNodeFromTgz(decompressed);
    if (!nodeData) throw new Error(".node file not found in tarball");

    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(dotNode, nodeData);

    // Write minimal package.json so require() resolution works
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: `@antoniomuso/${pkg}`, version: VERSION }),
    );

    return "installed";
  } catch (err) {
    // Clean up failed attempt
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
    return "failed";
  }
}

async function main() {
  for (const pkg of PACKAGES) {
    const scope = "@antoniomuso";
    const fullName = `${scope}/${pkg}`;
    const dotNode = path.join(
      destBase,
      pkg,
      `lz4-napi.${pkg.replace("lz4-napi-", "")}.node`,
    );

    if (fs.existsSync(dotNode)) {
      console.log(`Skipping ${fullName} (already installed)`);
      skipped++;
      continue;
    }

    console.log(`Downloading ${fullName}...`);
    const result = await installPackage(pkg);
    if (result === "installed") {
      console.log("  OK");
      installed++;
    } else {
      console.error("  FAILED");
      failed++;
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
  console.log(
    `\n=== ${nodeFiles.length} platform binaries (${(totalSize / 1024 / 1024).toFixed(1)} MB) | ` +
      `${installed} installed, ${skipped} skipped, ${failed} failed ===`,
  );
  for (const f of nodeFiles) {
    console.log(`  ${(fs.statSync(f).size / 1024).toFixed(0)}K  ${path.relative(destBase, f)}`);
  }

  if (failed > 0) {
    console.error(`\nWARNING: ${failed} platform(s) failed to download.`);
  }
}

main().catch(console.error);
