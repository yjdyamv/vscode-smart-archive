const https = require("https");
const fs = require("fs");
const path = require("path");

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

async function downloadWithCache({ cacheDir, cacheKey, fetch, destPath }) {
  if (fs.existsSync(destPath)) return { status: "skipped" };

  const cachedFile = path.join(cacheDir, cacheKey);

  if (fs.existsSync(cachedFile)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(cachedFile, destPath);
    return { status: "cached" };
  }

  try {
    const data = await fetch();

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

module.exports = { httpGet, httpGetJson, downloadWithCache };
