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

function httpGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("too many redirects"));
    const opts = { timeout: 30000 };
    if (AGENT) opts.agent = AGENT;
    const req = https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).toString(), redirects - 1)
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

async function downloadWithCache({
  cacheDir,
  cacheKey,
  fetch,
  destPath,
  expectedSha256,
  requireHash,
  label,
}) {
  if (fs.existsSync(destPath)) return { status: "skipped" };

  const name = label || cacheKey;
  const cachedFile = path.join(cacheDir, cacheKey);

  if (fs.existsSync(cachedFile)) {
    const cached = fs.readFileSync(cachedFile);
    checkHash(cached, expectedSha256, requireHash, name); // throws (not swallowed) on mismatch/missing
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(cachedFile, destPath);
    return { status: "cached" };
  }

  let data;
  try {
    data = await fetch();
  } catch {
    try {
      fs.rmSync(path.dirname(destPath), { recursive: true, force: true });
    } catch {}
    try {
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

module.exports = { httpGet, httpGetJson, downloadWithCache, sha256, verifySha256, checkHash };
