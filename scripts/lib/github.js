const fs = require("fs");
const path = require("path");
const { httpGet, httpGetRetry, httpGetMirrored } = require("./http");
const { sha256 } = require("./hash-pins");

const API_HEADERS = {
  "User-Agent": "smart-archive-vscode",
  Accept: "application/vnd.github+json",
};

/**
 * Resolve an asset from a GitHub release, trying in order:
 *   1. the standard release URL (fast on unrestricted networks),
 *   2. the GitHub assets API (works where github.com HTML downloads stall),
 *   3. mirror prefixes (gh-proxy.com etc., last resort).
 * Callers still verify SHA-256 afterwards, so neither the API fallback nor
 * mirrors can inject binaries.
 */
async function fetchReleaseAsset({ repo, tag, assetName, expectedSha256 }) {
  const standardUrl = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
  const attempts = [
    ["standard", () => httpGetRetry(standardUrl, { timeoutMs: 20000, retries: 1 })],
    ["assets-api", () => fetchViaAssetsApi(repo, tag, assetName)],
    ["mirror", () => httpGetMirrored(standardUrl, { timeoutMs: 120000, retries: 1 })],
  ];
  let lastErr;
  for (const [label, fn] of attempts) {
    try {
      const buf = await fn();
      if (buf && buf.length > 0) {
        // A middlebox/proxy can return an HTTP 200 page instead of the asset.
        // Verify per strategy so a wrong body falls through to the next
        // source; downloadWithCache still re-checks before writing.
        if (expectedSha256 && sha256(buf) !== expectedSha256) {
          lastErr = new Error(
            `SHA-256 mismatch via ${label}: expected ${expectedSha256}, got ${sha256(buf)}`,
          );
          console.warn(`[github] ${assetName} ${label} failed: ${lastErr.message}`);
          continue;
        }
        console.log(`[github] ${assetName} fetched via ${label} (${buf.length} bytes)`);
        return buf;
      }
      lastErr = new Error(`${label}: empty response`);
    } catch (err) {
      lastErr = err;
      console.warn(
        `[github] ${assetName} ${label} failed: ${err && err.message ? err.message : err}`,
      );
    }
  }
  throw lastErr || new Error(`no fetch strategy succeeded for ${assetName}`);
}

/**
 * GitHub assets API: resolve the asset id for a release tag, then download
 * with `Accept: application/octet-stream`. api.github.com redirects (302)
 * straight to objects.githubusercontent.com, which is reachable even where
 * github.com HTML downloads stall. Big files can be slow — generous timeout.
 */
async function fetchViaAssetsApi(repo, tag, assetName) {
  const apiBase = `https://api.github.com/repos/${repo}`;
  const rel = await httpGet(`${apiBase}/releases/tags/${tag}`, 5, 20000, API_HEADERS);
  const assets = JSON.parse(rel.toString("utf8")).assets || [];
  const asset = assets.find((a) => a.name === assetName);
  if (!asset || !asset.id) {
    throw new Error(`asset "${assetName}" not found in release ${tag} (assets API)`);
  }
  const buf = await httpGetRetry(`${apiBase}/releases/assets/${asset.id}`, {
    timeoutMs: 300000,
    retries: 2,
    // API_HEADERS first: its Accept is intentionally overridden below, so
    // the request asks GitHub for the binary (302 to objects.githubusercontent.com)
    // instead of the asset metadata JSON.
    headers: { ...API_HEADERS, Accept: "application/octet-stream" },
  });
  if (
    buf.length > 0 &&
    buf[0] === 0x7b && // '{'
    buf.length < 4096 &&
    buf.toString("utf8", 0, 200).includes('"url":')
  ) {
    throw new Error(`assets API returned metadata JSON instead of the binary for ${assetName}`);
  }
  return buf;
}

async function defaultFetchJson(url) {
  const buf = await httpGet(url, 5, 20000, API_HEADERS);
  return JSON.parse(buf.toString("utf8"));
}

/**
 * Resolve the latest semver release tag of a GitHub repo, cached under
 * <cacheDir>/latest-version.txt for ttlMs. Falls back to `fallback` when the
 * API is unreachable. Injectable fetchJson makes the cache/fallback paths
 * testable without network.
 */
async function resolveLatestReleaseTag(
  repo,
  {
    cacheDir,
    ttlMs = 60 * 60 * 1000,
    fallback,
    pinHint = "pin the version explicitly",
    fetchJson = defaultFetchJson,
  } = {},
) {
  const cacheFile = path.join(cacheDir, "latest-version.txt");
  try {
    if (fs.existsSync(cacheFile)) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < ttlMs) {
        const cached = fs.readFileSync(cacheFile, "utf8").trim();
        if (cached) return cached;
      }
    }
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const body = await fetchJson(url);
    const tag = String(body.tag_name).replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+/.test(tag)) throw new Error(`unexpected release tag: ${tag}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, tag);
    return tag;
  } catch (err) {
    if (fallback === undefined) throw err;
    console.warn(
      `  cannot resolve latest release of ${repo} (${err.message}); ` +
        `falling back to ${fallback} — ${pinHint}`,
    );
    return fallback;
  }
}

module.exports = {
  fetchReleaseAsset,
  resolveLatestReleaseTag,
};
