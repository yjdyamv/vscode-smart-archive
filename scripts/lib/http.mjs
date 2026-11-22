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

async function httpGetJson(url) {
  const buf = await httpGet(url);
  return JSON.parse(buf.toString("utf8"));
}

export { httpGet, httpGetJson };
