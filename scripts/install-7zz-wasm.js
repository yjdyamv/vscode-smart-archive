#!/usr/bin/env node
/**
 * Stage the 7-Zip ZS (26.02) WebAssembly engine under vendor/7zz-wasm/.
 *
 * Downloads 7zz.js + 7zz.wasm from the 7-Zip-zstd-wasm GitHub release
 * (multi-threaded Emscripten build with ZSTD/Brotli/LZ4/LZ5/Lizard/FLZMA2
 * support), replacing the old js7z-tools (7-Zip 25.01) WASM engine.
 *
 * Source: https://github.com/yjdyamv/7-Zip-zstd-wasm/releases
 * (the wasm repo mirrors mcmilk/7-Zip-zstd release tags one-for-one, so the
 * tag here matches the upstream 7-Zip version — shared with the native
 * installer via scripts/lib/releases.js).
 *
 * The pinned hashes below match the official release assets under this tag
 * (multi-threaded wasm build with FLZMA2 dictionary/thread clamps and
 * link-time -O2), so `postinstall` downloads the exact published bytes.
 *
 * Fetch strategy (handled by scripts/lib/github.js):
 *   1. standard release URL  (fast on unrestricted networks)
 *   2. GitHub assets API      (api.github.com → 302 → objects.githubusercontent.com;
 *                              works where github.com HTML redirects are blocked)
 *   3. mirror prefixes        (gh-proxy.com etc., last resort)
 * Every file is verified against a pinned SHA-256 (fail-closed, so neither
 * mirrors nor the API fallback can inject binaries). To (re)generate hashes
 * after a release bump, run once with SA_HASH_BOOTSTRAP=1: the script prints
 * and persists the new hashes into EXPECTED_HASHES below, then stages them.
 */
const fs = require("fs");
const path = require("path");
const { fetchReleaseAsset } = require("./lib/github");
const { SEVEN_ZIP_ZSTD_WASM_REPO, SEVEN_ZIP_ZSTD_TAG } = require("./lib/releases");
const { downloadWithCache } = require("./lib/download");
const { persistBootstrapHash } = require("./lib/hash-pins");
const { writeFileAtomic } = require("./lib/fs");

const REPO = SEVEN_ZIP_ZSTD_WASM_REPO;
const TAG = SEVEN_ZIP_ZSTD_TAG;
const VER = TAG.replace(/^v/, "").split("-")[0];

// SHA-256 of each downloaded file (release assets). Fail-closed: with no
// pinned hash the install refuses unless SA_HASH_BOOTSTRAP=1.
//   SA_HASH_BOOTSTRAP=1 node scripts/install-7zz-wasm.js
const EXPECTED_HASHES = {
  "7zz.js": "a22596301fea5c3733d1da86c305a457453e872073d784ae9853b97fe046675f",
  "7zz.wasm": "1ce935e1dab25155186a7d25652fe178d923640bab6c3536e6d9b7fe8a966e67",
  LICENSE: "efd01ecf087d0345468c57f7146879952c39c8daf4c461876a95de1c0d1722f3",
};

const OUT = path.join(__dirname, "..", "vendor", "7zz-wasm");
const cacheDir = path.join(__dirname, "..", ".cache", "7zz-wasm");

const FILES = ["7zz.js", "7zz.wasm", "LICENSE"];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of FILES) {
    const destPath = path.join(OUT, name);
    const result = await downloadWithCache({
      cacheDir,
      cacheKey: `${TAG}-${name}`,
      destPath,
      expectedSha256: EXPECTED_HASHES[name],
      requireHash: true,
      label: name,
      fetch: () =>
        fetchReleaseAsset({
          repo: REPO,
          tag: TAG,
          assetName: name,
          expectedSha256: EXPECTED_HASHES[name],
        }),
    });
    console.log(`[7zz-wasm ${name}] ${result.status}`);
    if (result.status === "failed") {
      throw new Error(
        `Failed to download ${name} — refusing to leave an incomplete WASM engine in vendor/7zz-wasm/`,
      );
    }
    if (result.status === "downloaded") {
      persistBootstrapHash(__filename, destPath, name);
    }
  }

  const pkg = path.join(OUT, "package.json");
  if (!fs.existsSync(pkg)) {
    writeFileAtomic(
      pkg,
      Buffer.from(
        JSON.stringify(
          {
            name: "7zz-wasm",
            version: "26.02.0",
            private: true,
            description: `7-Zip ZS ${VER} WebAssembly engine (multi-threaded)`,
            main: "7zz.js",
            license: "LGPL-2.1-or-later",
          },
          null,
          2,
        ) + "\n",
      ),
    );
    console.log("[7zz-wasm] wrote vendor/7zz-wasm/package.json");
  }
  console.log(`[7zz-wasm] staged ${FILES.join(", ")} in vendor/7zz-wasm/`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[7zz-wasm] FAILED: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = {
  REPO,
  TAG,
  VER,
  FILES,
  EXPECTED_HASHES,
};
