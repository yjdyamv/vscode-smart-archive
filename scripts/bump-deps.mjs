#!/usr/bin/env node
/**
 * Apply engine dependency updates detected by check-updates.mjs.
 *
 * Every engine is an npm dependency now, so for each update this script:
 *   1. runs `npm install <pkg>@<version>` — package.json plus the lockfile are
 *      the pin (there is no in-repo version constant any more),
 *   2. re-runs the affected installer so the staged artifacts follow the bump
 *      (snappy regenerates its node_modules prebuilds; the 7-Zip and WASM
 *      engines have no installer — the installed package IS the pin),
 *   3. verifies the installers end-to-end (scripts/verify-downloads.mjs,
 *      fail-closed).
 *
 * Usage:
 *   node scripts/bump-deps.mjs                # bump everything available
 *   node scripts/bump-deps.mjs 7z rar5        # only the named deps (7z 7zz rar5 snappy)
 *   node scripts/bump-deps.mjs --dry-run      # report the plan, change nothing
 *   node scripts/bump-deps.mjs --skip-verify  # skip the verify step
 *
 * Intended for local runs and the scheduled update-deps CI workflow: the
 * resulting diff (package.json + lockfile + staged binaries) is reviewed as a
 * pull request.
 *
 * The planning logic is exported and unit-tested with an injected fetchJson;
 * applyUpdates runs real installers (network) and is exercised by the CI
 * workflow, not by unit tests.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { defaultFetchJson, SNAPPY_BLOCKED_VERSIONS } from "./check-updates.mjs";

const SCRIPTS_DIR = import.meta.dirname;
const ROOT_DIR = path.join(SCRIPTS_DIR, "..");
const ROOT_PACKAGE_JSON = path.join(ROOT_DIR, "package.json");

async function npmLatestVersion(pkgName, fetchJson) {
  const body = await fetchJson(`https://registry.npmjs.org/${pkgName}/latest`);
  return String(body.version);
}

/** Strip a leading "^" (npm caret range) for comparison. */
export function stripCaret(v) {
  return String(v).replace(/^\^/, "");
}

/**
 * One planned update:
 *   key        — "7z" | "7zz" | "rar5" | "snappy"
 *   name       — human-readable label
 *   current    — declared version range today (e.g. "^26.5.0")
 *   latest     — version to bump to
 *   pkg        — package name to `npm install <pkg>@<latest>`
 *   installers — installer scripts to re-run so staged artifacts follow
 *
 * @typedef {{key: string, name: string, current: string, latest: string,
 *   pkg: string, installers: string[]}} BumpPlan
 */

/**
 * Compute which dependencies have a newer release. Read-only; injectable
 * fetchJson for tests; rootPkg points at a package.json whose dependencies are
 * the current declarations of the npm engines.
 *
 * @param {{fetchJson?: Function, rootPkg?: string}} [opts]
 * @returns {Promise<BumpPlan[]>}
 */
export async function planUpdates({
  fetchJson = defaultFetchJson,
  rootPkg = ROOT_PACKAGE_JSON,
} = {}) {
  const updates = [];
  const declared = readDeclaredDeps(rootPkg);

  // npm engines: package.json + lockfile are the only pin, so a newer registry
  // version is the whole plan. snappy additionally stages prebuilds via its
  // installer and has a known-broken release that must never be offered.
  for (const engine of [
    {
      key: "7z",
      name: "7-Zip ZS native (npm)",
      pkg: "7zip-zstd-native",
      installers: [],
    },
    {
      key: "7zz",
      name: "7-Zip ZS WASM (npm)",
      pkg: "7zip-zstd-wasm",
      installers: [],
    },
    {
      key: "rar5",
      name: "rar-rs (npm)",
      pkg: "@yjdyamv/rar-rs",
      installers: [],
    },
    {
      key: "snappy",
      name: "snappy (npm)",
      pkg: "snappy",
      installers: ["install-snappy-platforms.mjs"],
      blocked: SNAPPY_BLOCKED_VERSIONS,
    },
  ]) {
    const latest = await npmLatestVersion(engine.pkg, fetchJson);
    const current = declared[engine.pkg];
    if (current === undefined) continue; // not a declared dependency
    const blockedReason = engine.blocked?.get(latest);
    if (blockedReason) {
      // Known-broken release: do NOT plan a bump.
      console.warn(`[bump-deps] ${engine.pkg} ${latest} is blocked from bumping: ${blockedReason}`);
      continue;
    }
    if (stripCaret(current) === latest) continue;
    updates.push({
      key: engine.key,
      name: engine.name,
      current,
      latest,
      pkg: engine.pkg,
      installers: engine.installers,
    });
  }

  return updates;
}

/** `dependencies` map of the root package.json, or {} when it is missing. */
function readDeclaredDeps(rootPkg) {
  if (!fs.existsSync(rootPkg)) return {};
  return JSON.parse(fs.readFileSync(rootPkg, "utf8")).dependencies ?? {};
}

/**
 * Apply the planned updates: `npm install <pkg>@<version>`, then re-run the
 * affected installers so the staged artifacts follow the bump. Returns a
 * per-dep summary.
 */
export async function applyUpdates(updates, { runInstallers = true } = {}) {
  const results = [];
  for (const u of updates) {
    execFileSync("npm", ["install", `${u.pkg}@${u.latest}`], {
      stdio: "inherit",
      cwd: ROOT_DIR,
    });
    if (runInstallers) {
      for (const inst of u.installers) {
        console.log(`[bump-deps] ${u.key}: staging via ${inst}`);
        execFileSync(process.execPath, [path.join(SCRIPTS_DIR, inst)], {
          stdio: "inherit",
          env: {
            ...process.env,
            // snappy regenerates its pinned hashes in place; the other
            // installers ignore this.
            SA_HASH_BOOTSTRAP: "1",
            ...(u.key === "rar5" ? { SA_RAR5_REQUIRE: "1" } : {}),
          },
        });
      }
    }
    results.push({ key: u.key, name: u.name, from: u.current, to: u.latest, status: "applied" });
  }
  return results;
}

function verifyDownloads() {
  console.log("[bump-deps] verifying all installers with fresh downloads...");
  execFileSync(process.execPath, [path.join(SCRIPTS_DIR, "verify-downloads.mjs")], {
    stdio: "inherit",
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipVerify = args.includes("--skip-verify");
  const only = args.filter((a) => ["7z", "7zz", "rar5", "snappy"].includes(a));

  const updates = await planUpdates();
  const selected = only.length > 0 ? updates.filter((u) => only.includes(u.key)) : updates;

  if (selected.length === 0) {
    console.log("[bump-deps] all engine dependencies are up to date.");
    return;
  }

  console.log("[bump-deps] updates available:");
  for (const u of selected) {
    console.log(`  ${u.name}: ${u.current} -> ${u.latest}`);
  }

  if (dryRun) {
    console.log("[bump-deps] dry-run — nothing changed.");
    return;
  }

  const applied = await applyUpdates(selected);
  if (!skipVerify) verifyDownloads();
  console.log("[bump-deps] done:");
  for (const r of applied) console.log(`  ${r.key}: ${r.from} -> ${r.to}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[bump-deps] FAILED: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
