#!/usr/bin/env node
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { httpGet, httpGetJson, downloadWithCache } = require("./lib/download-cache");

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
  "lz4-napi-linux-x64-gnu": { os: ["linux"], cpu: ["x64"] },
  "lz4-napi-linux-x64-musl": { os: ["linux"], cpu: ["x64"] },
  "lz4-napi-linux-arm64-gnu": { os: ["linux"], cpu: ["arm64"] },
  "lz4-napi-linux-arm64-musl": { os: ["linux"], cpu: ["arm64"] },
  "lz4-napi-linux-arm-gnueabihf": { os: ["linux"], cpu: ["arm"] },
  "lz4-napi-darwin-x64": { os: ["darwin"], cpu: ["x64"] },
  "lz4-napi-darwin-arm64": { os: ["darwin"], cpu: ["arm64"] },
  "lz4-napi-win32-x64-msvc": { os: ["win32"], cpu: ["x64"] },
  "lz4-napi-win32-arm64-msvc": { os: ["win32"], cpu: ["arm64"] },
  "lz4-napi-win32-ia32-msvc": { os: ["win32"], cpu: ["ia32"] },
};

// SHA-256 of each platform's .node, verified on download (fail-closed).
// This map MUST be populated before release: with requireHash the build refuses
// any binary lacking a pinned hash. To (re)generate after an lz4-napi bump, run
// once and paste the printed values keyed by package name:
//   SA_HASH_BOOTSTRAP=1 node scripts/install-lz4-platforms.js
const EXPECTED_HASHES = {
  "lz4-napi-linux-x64-gnu": "6af66541006fbbbf54374179bcb13252f25d0b394b38dc217b567a966992cc18",
  "lz4-napi-linux-x64-musl": "b757afebe9122dd9eaa57dfc9d3ae5e2b4a44f6df0125ea6c667f0a9f492d58d",
  "lz4-napi-linux-arm64-gnu": "704e743524cbcc81aae369bb4e54e389b691a05577d74512feb070db1e3401bd",
  "lz4-napi-linux-arm64-musl": "7064336df491df374bba2a5e665a635bd1b310a400cd608b746255d0bf8cf6c4",
  "lz4-napi-linux-arm-gnueabihf":
    "f483803b1e8ef42bcff9db1590d889f33ae48cdcb7b0747639aeffa8a2071fe6",
  "lz4-napi-darwin-x64": "c64076947d80334c388624752120a017c93c03708f20860db260733f53ef019a",
  "lz4-napi-darwin-arm64": "c54e7abd0af3934a33b25b770894952b0ca49ec7708f5a15b3b98697dc03bda0",
  "lz4-napi-win32-x64-msvc": "e56309e6dd0b3280455a93f95a2a75badde202d7e3186d1d62f8864478c8b0fa",
  "lz4-napi-win32-arm64-msvc": "368750d87099c9e513f93bd690cfec10cb5634bdcb22d64c3f633a712057b18a",
  "lz4-napi-win32-ia32-msvc": "321df23e6bed99539202bde63b01107982123b133b122a1fdd14da2a5588ea5a",
};

const destBase = path.join(__dirname, "..", "node_modules", "@antoniomuso");
const lz4Dir = path.join(__dirname, "..", "node_modules", "lz4-napi");
const cacheDir = path.join(__dirname, "..", ".cache", "lz4-platforms");

fs.mkdirSync(destBase, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

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
  const destPath = path.join(pkgDir, nodeFileName);

  const result = await downloadWithCache({
    cacheDir,
    cacheKey: nodeFileName,
    destPath,
    expectedSha256: EXPECTED_HASHES[pkg],
    requireHash: true,
    label: pkg,
    fetch: async () => {
      const metaUrl = `https://registry.npmjs.org/@antoniomuso/${pkg}/${VERSION}`;
      const meta = await httpGetJson(metaUrl);
      const tarballUrl = meta.dist && meta.dist.tarball;
      if (!tarballUrl) throw new Error("no tarball URL in metadata");

      const tgz = await httpGet(tarballUrl);
      const decompressed = zlib.gunzipSync(tgz);
      const nodeData = extractNodeFromTgz(decompressed);
      if (!nodeData) throw new Error(".node file not found in tarball");
      return nodeData;
    },
  });

  if (result.status === "downloaded" || result.status === "cached") {
    writePkgJson(pkgDir, pkg, nodeFileName);
  }

  return result;
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
