#!/usr/bin/env node
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");
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

const PLATFORM_META = {
  "lz4-napi-linux-x64-gnu":       { os: ["linux"],   cpu: ["x64"] },
  "lz4-napi-linux-x64-musl":      { os: ["linux"],   cpu: ["x64"] },
  "lz4-napi-linux-arm64-gnu":     { os: ["linux"],   cpu: ["arm64"] },
  "lz4-napi-linux-arm64-musl":    { os: ["linux"],   cpu: ["arm64"] },
  "lz4-napi-linux-arm-gnueabihf": { os: ["linux"],   cpu: ["arm"] },
  "lz4-napi-darwin-x64":          { os: ["darwin"],  cpu: ["x64"] },
  "lz4-napi-darwin-arm64":        { os: ["darwin"],  cpu: ["arm64"] },
  "lz4-napi-win32-x64-msvc":      { os: ["win32"],   cpu: ["x64"] },
  "lz4-napi-win32-arm64-msvc":    { os: ["win32"],   cpu: ["arm64"] },
  "lz4-napi-win32-ia32-msvc":     { os: ["win32"],   cpu: ["ia32"] },
};

const destBase = path.join(__dirname, "..", "node_modules", "@antoniomuso");
const lz4Dir = path.join(__dirname, "..", "node_modules", "lz4-napi");
const cacheDir = path.join(__dirname, "..", ".cache", "lz4-platforms");
const skipVerify = process.argv.includes("--skip-verify");

fs.mkdirSync(destBase, { recursive: true });
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

function writePkgJson(pkgDir, pkg, nodeFileName) {
  const metaInfo = PLATFORM_META[pkg] || {};
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: `@antoniomuso/${pkg}`,
      version: VERSION,
      main: nodeFileName,
      os: metaInfo.os,
      cpu: metaInfo.cpu,
      files: [nodeFileName],
      description: "lz4-napi platform-specific binary",
      license: "MIT",
      repository: { type: "git", url: "https://github.com/antoniomuso/lz4-napi.git" },
    }),
  );
}

async function resolvePackage(pkg) {
  const pkgDir = path.join(destBase, pkg);
  const nodeFileName = `lz4-napi.${pkg.replace("lz4-napi-", "")}.node`;
  const dotNode = path.join(pkgDir, nodeFileName);
  const cachedFile = path.join(cacheDir, nodeFileName);
  const cachedHash = cachedFile + ".sha256";

  if (fs.existsSync(dotNode)) return { status: "skipped" };

  const cacheValid = () => {
    if (!fs.existsSync(cachedFile)) return false;
    if (!skipVerify && fs.existsSync(cachedHash)) {
      const expected = fs.readFileSync(cachedHash, "utf8").trim();
      const actual = sha256(fs.readFileSync(cachedFile));
      if (expected !== actual) {
        console.error(`  ! cache hash mismatch for ${pkg}, re-downloading`);
        return false;
      }
    }
    return true;
  };

  if (cacheValid()) {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.copyFileSync(cachedFile, dotNode);
    writePkgJson(pkgDir, pkg, nodeFileName);
    return { status: "cached" };
  }

  try {
    const metaUrl = `https://registry.npmjs.org/@antoniomuso/${pkg}/${VERSION}`;
    const meta = await httpGetJson(metaUrl);
    const tarballUrl = meta.dist && meta.dist.tarball;
    if (!tarballUrl) throw new Error("no tarball URL in metadata");

    const tgz = await httpGet(tarballUrl);
    const decompressed = zlib.gunzipSync(tgz);
    const nodeData = extractNodeFromTgz(decompressed);
    if (!nodeData) throw new Error(".node file not found in tarball");

    const hash = sha256(nodeData);
    fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
    fs.writeFileSync(cachedFile, nodeData);
    fs.writeFileSync(cachedHash, hash + "\n");

    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(dotNode, nodeData);
    writePkgJson(pkgDir, pkg, nodeFileName);
    return { status: "downloaded" };
  } catch (err) {
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
    return { status: "failed" };
  }
}

async function main() {
  let installed = 0;
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const pkg of PACKAGES) {
    console.log(`[@antoniomuso/${pkg}]`);
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

  if (fs.existsSync(lz4Dir)) {
    for (const pkg of PACKAGES) {
      const nodeFileName = `lz4-napi.${pkg.replace("lz4-napi-", "")}.node`;
      const srcPath = path.join(destBase, pkg, nodeFileName);
      if (!fs.existsSync(srcPath)) continue;

      const destPath = path.join(lz4Dir, nodeFileName);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  const nodeFiles = [];
  for (const pkg of PACKAGES) {
    const nodeFileName = `lz4-napi.${pkg.replace("lz4-napi-", "")}.node`;
    const f = path.join(destBase, pkg, nodeFileName);
    if (fs.existsSync(f)) nodeFiles.push(f);
  }

  const totalSize = nodeFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
  console.log(
    `\n=== ${nodeFiles.length} platform binaries (${(totalSize / 1024 / 1024).toFixed(1)} MB) | ` +
      `${installed} downloaded, ${cached} cached, ${skipped} skipped, ${failed} failed ===`,
  );
  for (const f of nodeFiles) {
    const pkg = path.basename(path.dirname(f));
    const rel = `${pkg}/${path.basename(f)}`;
    console.log(`  ${(fs.statSync(f).size / 1024).toFixed(0)}K  ${rel}`);
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
