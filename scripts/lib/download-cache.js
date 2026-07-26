const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function verifySha256(data, expected, label) {
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}`,
    );
  }
}

async function downloadWithCache({ cacheDir, cacheKey, fetch, destPath, expectedSha256, label }) {
  if (fs.existsSync(destPath)) return { status: "skipped" };

  const cachedFile = path.join(cacheDir, cacheKey);

  if (fs.existsSync(cachedFile)) {
    if (expectedSha256) {
      const cached = fs.readFileSync(cachedFile);
      verifySha256(cached, expectedSha256, label || cacheKey);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(cachedFile, destPath);
    return { status: "cached" };
  }

  try {
    const data = await fetch();

    if (expectedSha256) {
      verifySha256(data, expectedSha256, label || cacheKey);
    }

    fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
    fs.writeFileSync(cachedFile, data);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, data);
    return { status: "downloaded" };
  } catch {
    try { fs.rmSync(path.dirname(destPath), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(cachedFile, { force: true }); } catch {}
    return { status: "failed" };
  }
}

module.exports = { httpGet, httpGetJson, downloadWithCache, sha256, verifySha256 };
