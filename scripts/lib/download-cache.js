const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HttpsProxyAgent } = require("https-proxy-agent");

const AGENT = (() => {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl) {
    try {
      return new HttpsProxyAgent(proxyUrl);
    } catch {
      return undefined;
    }
  }
})();

function httpGet(url, redirects = 5, timeoutMs = 30000, headers = {}) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("too many redirects"));
    const opts = { timeout: timeoutMs, headers };
    if (AGENT) opts.agent = AGENT;
    const req = https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).toString(), redirects - 1, timeoutMs)
          .then(resolve)
          .catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/**
 * httpGet with exponential-backoff retries (transient network failures,
 * timeouts and 5xx). 3 attempts: 500ms / 1s / 2s delays.
 */
async function httpGetRetry(url, { timeoutMs = 30000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpGet(url, 5, timeoutMs);
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      // 4xx is deterministic — do not retry.
      if (msg.startsWith("HTTP 4")) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

// GitHub download mirrors tried AFTER a direct fetch fails. Prefixes are
// prepended verbatim to the original URL. Override/extend via the
// SA_GITHUB_MIRRORS env var (comma-separated prefixes).
function githubMirrors() {
  const fromEnv = (process.env.SA_GITHUB_MIRRORS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...fromEnv, "https://gh-proxy.com/"];
}

/**
 * Fetch a URL, falling back to GitHub mirror prefixes on failure.
 * Direct connection first — mirrors only kick in when it fails or times
 * out, so normal-network behaviour is unchanged. All callers still verify
 * SHA-256 afterwards, so a compromised mirror cannot inject binaries.
 */
async function httpGetMirrored(url, opts = {}) {
  const urls = [url, ...githubMirrors().map((p) => `${p}${url}`)];
  let lastErr;
  for (const candidate of urls) {
    try {
      return await httpGetRetry(candidate, opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function httpGetJson(url) {
  const buf = await httpGet(url);
  return JSON.parse(buf.toString("utf8"));
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function verifySha256(data, expected, label) {
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}`);
  }
}

/**
 * Verify a downloaded/cached binary against its pinned hash. Fail-closed:
 * when `requireHash` is set and no pinned hash exists, refuse to use the
 * binary — UNLESS SA_HASH_BOOTSTRAP=1, which prints the computed hash so a
 * maintainer can populate the EXPECTED_HASHES map in one pass, then proceeds.
 */
function checkHash(data, expected, requireHash, label) {
  const actual = sha256(data);
  if (expected) {
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (requireHash) {
    if (process.env.SA_HASH_BOOTSTRAP === "1") {
      console.warn(`[hash-bootstrap] ${label} = ${actual}`);
      return;
    }
    throw new Error(
      `No pinned SHA-256 for "${label}". Refusing to bundle an unverified native binary.\n` +
        `  Collect hashes once:  SA_HASH_BOOTSTRAP=1 <build command>\n` +
        `  then paste the printed values into the EXPECTED_HASHES map.`,
    );
  }
}

/**
 * Extract the first file ending with ".node" from a gzipped npm tarball (tgz).
 * Returns the raw .node data, or null if not found.
 */
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
    if (!isDir && name.endsWith(".node")) return buf.subarray(pos, pos + size);
    pos = dataEnd;
  }
  return null;
}

async function downloadWithCache({
  cacheDir,
  cacheKey,
  fetch,
  destPath,
  expectedSha256,
  requireHash,
  label,
}) {
  const name = label || cacheKey;

  // A staged destination is only reusable when it already matches the
  // pinned hash. Anything else (local dev build, previous release, partial
  // write) must be replaced, otherwise a version bump silently ships stale
  // binaries. Bootstrap mode re-downloads fresh so the printed hash always
  // describes the current release asset.
  if (fs.existsSync(destPath)) {
    const existing = fs.readFileSync(destPath);
    if (expectedSha256 && sha256(existing) === expectedSha256) {
      return { status: "skipped" };
    }
    if (!expectedSha256 && !requireHash) {
      // No pin and not fail-closed: keep whatever a local/dev stage left.
      return { status: "skipped" };
    }
    fs.rmSync(destPath, { force: true });
  }

  const cachedFile = path.join(cacheDir, cacheKey);

  if (fs.existsSync(cachedFile)) {
    const cached = fs.readFileSync(cachedFile);
    if (expectedSha256) {
      if (sha256(cached) !== expectedSha256) {
        // Stale cache from an older release (cache keys are versioned, but a
        // manually seeded cache may still collide): drop and download fresh.
        fs.rmSync(cachedFile, { force: true });
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(cachedFile, destPath);
        return { status: "cached" };
      }
    } else if (requireHash) {
      // Bootstrap mode: ignore any cached bytes so the printed hash comes
      // from the current release asset.
      fs.rmSync(cachedFile, { force: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(cachedFile, destPath);
      return { status: "cached" };
    }
  }

  let data;
  try {
    data = await fetch();
  } catch {
    try {
      fs.rmSync(destPath, { force: true });
      fs.rmSync(cachedFile, { force: true });
    } catch {}
    return { status: "failed" };
  }

  // Verify BEFORE writing. A hash failure must abort the whole build — it is
  // intentionally NOT caught by the network try/catch above (which only
  // tolerates transient download failures).
  checkHash(data, expectedSha256, requireHash, name);

  fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
  fs.writeFileSync(cachedFile, data);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, data);
  return { status: "downloaded" };
}

module.exports = {
  httpGet,
  httpGetRetry,
  httpGetMirrored,
  httpGetJson,
  downloadWithCache,
  sha256,
  verifySha256,
  checkHash,
  extractNodeFromTgz,
};
