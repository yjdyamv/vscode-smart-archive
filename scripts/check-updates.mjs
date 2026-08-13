#!/usr/bin/env node
/**
 * Check for newer releases of the bundled engine dependencies.
 *
 * Read-only: never modifies files, never downloads binaries. Compares the
 * in-repo pins (scripts/lib/releases.mjs) against the live upstreams:
 *
 *   1. 7-Zip ZS native + WASM  — yjdyamv/7-Zip-zstd-native latest release tag
 *      vs SEVEN_ZIP_ZSTD_TAG (also warns when the mirror repo lags behind
 *      upstream mcmilk/7-Zip-zstd — a security-relevant staleness signal).
 *   2. rar5 binding             — yjdyamv/smart-archive-rar latest release tag
 *      vs RAR5_VERSION.
 *   3. snappy (npm)             — registry latest vs the installed
 *      node_modules/snappy version (what install-snappy-platforms stages).
 *
 * Usage:
 *   node scripts/check-updates.mjs            # human-readable report
 *   node scripts/check-updates.mjs --json     # machine-readable
 *   node scripts/check-updates.mjs --strict   # network errors exit 2
 *
 * Exit codes: 0 = all up to date (or the check was unavailable), 1 = an
 * update is available, 2 = error (only with --strict; default is warn+0 so
 * a flaky network never fails CI).
 *
 * The check logic is exported for tests; fetchJson is injectable so the
 * comparison/exit logic is testable without network.
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "node:url";
import {
  SEVEN_ZIP_ZSTD_REPO,
  SEVEN_ZIP_ZSTD_TAG,
  RAR5_REPO,
  RAR5_VERSION,
} from "./lib/releases.mjs";

const UPSTREAM_7Z_REPO = "mcmilk/7-Zip-zstd";

const API_HEADERS = { "User-Agent": "smart-archive-vscode", Accept: "application/vnd.github+json" };

/** "v26.02-v1.5.7-R2" → "26.02-v1.5.7-R2" (and "0.3.2" stays "0.3.2"). */
function normalizeTag(tag) {
  return String(tag).replace(/^v/, "");
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function latestGithubTag(repo, fetchJson) {
  const body = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  return String(body.tag_name);
}

async function checkSevenZip(fetchJson) {
  const mirrorTag = await latestGithubTag(SEVEN_ZIP_ZSTD_REPO, fetchJson);
  const result = {
    name: "7-Zip ZS (native+wasm)",
    current: SEVEN_ZIP_ZSTD_TAG,
    latest: mirrorTag,
    status: "up-to-date",
    url: `https://github.com/${SEVEN_ZIP_ZSTD_REPO}/releases/tag/${mirrorTag}`,
  };
  if (normalizeTag(mirrorTag) !== normalizeTag(SEVEN_ZIP_ZSTD_TAG)) {
    result.status = "update-available";
    return result;
  }
  // Mirror is current — but is the mirror itself behind upstream 7-Zip ZS?
  try {
    const upstreamTag = await latestGithubTag(UPSTREAM_7Z_REPO, fetchJson);
    if (normalizeTag(upstreamTag) !== normalizeTag(mirrorTag)) {
      result.status = "mirror-behind-upstream";
      result.latest = `${mirrorTag} (upstream ${UPSTREAM_7Z_REPO}: ${upstreamTag})`;
      result.url = `https://github.com/${UPSTREAM_7Z_REPO}/releases/tag/${upstreamTag}`;
    }
  } catch {
    // Upstream check is informational — ignore failures.
  }
  return result;
}

async function checkRar5(fetchJson) {
  const latest = await latestGithubTag(RAR5_REPO, fetchJson);
  return {
    name: "rar5 binding (smart-archive-rar)",
    current: RAR5_VERSION,
    latest,
    status: normalizeTag(latest) === normalizeTag(RAR5_VERSION) ? "up-to-date" : "update-available",
    url: `https://github.com/${RAR5_REPO}/releases/tag/v${normalizeTag(latest)}`,
  };
}

async function checkSnappy(fetchJson, pkgPath = path.join(import.meta.dirname, "..", "node_modules", "snappy", "package.json")) {
  const latestBody = await fetchJson("https://registry.npmjs.org/snappy/latest");
  const latest = String(latestBody.version);
  let current = "unknown";
  if (fs.existsSync(pkgPath)) {
    current = String(JSON.parse(fs.readFileSync(pkgPath, "utf8")).version);
  }
  return {
    name: "snappy (npm)",
    current,
    latest,
    status: current === "unknown" ? "unavailable" : current === latest ? "up-to-date" : "update-available",
    url: "https://www.npmjs.com/package/snappy",
  };
}

/**
 * Run all checks. Every check failure is caught and reported as
 * `status: "unavailable"` so one dead endpoint cannot fail the batch.
 * `snappyPkgPath` is injectable for tests (defaults to the installed
 * node_modules/snappy/package.json).
 */
export async function checkUpdates({ fetchJson = defaultFetchJson, snappyPkgPath } = {}) {
  const checks = [
    ["7-Zip ZS", () => checkSevenZip(fetchJson)],
    ["rar5", () => checkRar5(fetchJson)],
    ["snappy", () => checkSnappy(fetchJson, snappyPkgPath)],
  ];
  const results = [];
  for (const [key, fn] of checks) {
    try {
      results.push({ key, ...(await fn()) });
    } catch (err) {
      results.push({
        key,
        name: key,
        current: "unknown",
        latest: "unknown",
        status: "unavailable",
        error: err && err.message ? err.message : String(err),
      });
    }
  }
  return results;
}

export function hasUpdate(results) {
  return results.some((r) => r.status === "update-available" || r.status === "mirror-behind-upstream");
}

function printHuman(results) {
  console.log("=== Smart Archive dependency update check ===");
  for (const r of results) {
    const line = `[${r.name}] current ${r.current} / latest ${r.latest} — ${r.status}`;
    if (r.status === "update-available" || r.status === "mirror-behind-upstream") {
      console.log(`  ⬆  ${line}`);
      console.log(`     ${r.url}`);
    } else if (r.status === "unavailable") {
      console.warn(`  ?  ${line} (${r.error ?? "check failed"})`);
    } else {
      console.log(`  ✔  ${line}`);
    }
  }
  if (!hasUpdate(results)) {
    console.log("All engine dependencies are up to date.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const strict = args.includes("--strict");
  const results = await checkUpdates();
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printHuman(results);
  }
  if (hasUpdate(results)) process.exitCode = 1;
  else if (strict && results.some((r) => r.status === "unavailable")) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[check-updates] FAILED: ${err && err.message ? err.message : err}`);
    process.exit(2);
  });
}
