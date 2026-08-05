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
 * tag here matches the upstream 7-Zip version — keep in sync with
 * install-7z-platforms.js).
 *
 * Fetch strategy (network environments vary widely):
 *   1. standard release URL  (fast on unrestricted networks)
 *   2. GitHub assets API      (api.github.com → 302 → objects.githubusercontent.com;
 *                              works where github.com HTML redirects are blocked)
 *   3. mirror prefixes        (gh-proxy.com etc., last resort)
 * Every file is verified against a pinned SHA-256 (fail-closed, so neither
 * mirrors nor the API fallback can inject binaries). To (re)generate hashes
 * after a release bump, run once with SA_HASH_BOOTSTRAP=1 and paste the
 * printed values into EXPECTED_HASHES below.
 */
const fs = require("fs");
const path = require("path");
const { downloadWithCache, httpGet, httpGetRetry } = require("./lib/download-cache");

// Keep in sync with install-7z-platforms.js (7-Zip version) and the latest
// 7-Zip-zstd-wasm release tag.
const VER = "26.02";
const TAG = "v26.02-v1.5.7-R2";
const REPO = "yjdyamv/7-Zip-zstd-wasm";
const BASE = `https://github.com/${REPO}/releases/download/${TAG}`;
const API_BASE = `https://api.github.com/repos/${REPO}`;

// SHA-256 of each downloaded file (release assets). Fail-closed: with no
// pinned hash the install refuses unless SA_HASH_BOOTSTRAP=1.
//   SA_HASH_BOOTSTRAP=1 node scripts/install-7zz-wasm.js
const EXPECTED_HASHES = {
  "7zz.js": "c90601e3456f0ee7732ea6df47220a1d6498361cd9d898e18deff13d88303df4",
  "7zz.wasm": "2d21b67bddfc1b1ef68d8f68394819ac2e219b1ce366f56db8546603bc8b650d",
  LICENSE: "efd01ecf087d0345468c57f7146879952c39c8daf4c461876a95de1c0d1722f3",
};

const OUT = path.join(__dirname, "..", "vendor", "7zz-wasm");
const cacheDir = path.join(__dirname, "..", ".cache", "7zz-wasm");

const FILES = ["7zz.js", "7zz.wasm", "LICENSE"];

/** Standard release URL — fast path, short timeout so we fall back quickly. */
async function fetchStandard(name) {
  return await httpGetRetry(`${BASE}/${name}`, { timeoutMs: 20000, retries: 1 });
}

/**
 * GitHub assets API: resolve the asset id for a release tag, then download
 * with `Accept: application/octet-stream`. api.github.com redirects (302)
 * straight to objects.githubusercontent.com, which is reachable even where
 * github.com HTML downloads stall. Big files can be slow — generous timeout.
 */
async function fetchAssetApi(name) {
  const apiHeaders = { "User-Agent": "smart-archive-install" };
  const rel = await httpGet(`${API_BASE}/releases/tags/${TAG}`, 5, 20000, apiHeaders);
  const assets = JSON.parse(rel.toString("utf8")).assets || [];
  const asset = assets.find((a) => a.name === name);
  if (!asset || !asset.id) {
    throw new Error(`asset "${name}" not found in release ${TAG} (assets API)`);
  }
  return await httpGetRetry(`${API_BASE}/releases/assets/${asset.id}`, {
    timeoutMs: 300000,
    retries: 2,
    headers: { Accept: "application/octet-stream", ...apiHeaders },
  });
}

/** Mirror prefixes (gh-proxy.com etc.), last resort. */
async function fetchMirror(name) {
  const { httpGetMirrored } = require("./lib/download-cache");
  return await httpGetMirrored(`${BASE}/${name}`, { timeoutMs: 60000 });
}

async function fetchWithFallback(name) {
  const attempts = [
    ["standard", () => fetchStandard(name)],
    ["assets-api", () => fetchAssetApi(name)],
    ["mirror", () => fetchMirror(name)],
  ];
  let lastErr;
  for (const [label, fn] of attempts) {
    try {
      const buf = await fn();
      if (buf && buf.length > 0) {
        console.log(`[7zz-wasm ${name}] fetched via ${label} (${buf.length} bytes)`);
        return buf;
      }
      lastErr = new Error(`${label}: empty response`);
    } catch (err) {
      lastErr = err;
      console.warn(`[7zz-wasm ${name}] ${label} failed: ${err && err.message ? err.message : err}`);
    }
  }
  throw lastErr || new Error(`no fetch strategy succeeded for ${name}`);
}

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
      fetch: () => fetchWithFallback(name),
    });
    console.log(`[7zz-wasm ${name}] ${result.status}`);
  }

  const pkg = path.join(OUT, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(
      pkg,
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
    );
    console.log("[7zz-wasm] wrote vendor/7zz-wasm/package.json");
  }
  console.log(`[7zz-wasm] staged ${FILES.join(", ")} in vendor/7zz-wasm/`);
}

main().catch((err) => {
  console.error(`[7zz-wasm] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
