import https from "https";

// https-proxy-agent ≥ 8 is ESM-only — dynamic import keeps this CJS module
// loadable by every install script. The agent is created lazily so a plain
// download without a proxy never pays the import cost.
let agentPromise;
function proxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  agentPromise ??= import("https-proxy-agent")
    .then((m) => new m.HttpsProxyAgent(proxyUrl))
    .catch(() => undefined);
  return agentPromise;
}

function httpGet(url, redirects = 5, timeoutMs = 30000, headers = {}) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("too many redirects"));
    const opts = { timeout: timeoutMs, headers };
    const agent = proxyAgent();
    if (agent) {
      Promise.resolve(agent).then((a) => {
        if (a) opts.agent = a;
        doGet(opts, url, redirects, timeoutMs, resolve, reject);
      });
      return;
    }
    doGet(opts, url, redirects, timeoutMs, resolve, reject);
  });
}

function doGet(opts, url, redirects, timeoutMs, resolve, reject) {
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
}

/**
 * httpGet with exponential-backoff retries (transient network failures,
 * timeouts and 5xx). 3 attempts: 500ms / 1s / 2s delays.
 */
async function httpGetRetry(url, { timeoutMs = 30000, retries = 3, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpGet(url, 5, timeoutMs, headers);
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
  // Verified mirrors, tried in order. ghproxy.net currently works where
  // gh-proxy.com hangs (HTTP/2 stream errors); keep both for resilience.
  return [...fromEnv, "https://ghproxy.net/", "https://gh-proxy.com/"];
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

export { httpGet, httpGetRetry, httpGetJson, httpGetMirrored };
