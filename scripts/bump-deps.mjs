#!/usr/bin/env node
/**
 * Apply engine dependency updates detected by check-updates.mjs.
 *
 * For each dependency with a newer release this script:
 *   1. bumps the in-repo version constant (scripts/lib/releases.mjs) for the
 *      native 7-Zip ZS release, or `npm install <pkg>@<version>` for the npm
 *      engines (7zip-zstd-wasm, @yjdyamv/rar-rs, snappy),
 *   2. re-runs the affected installer with SA_HASH_BOOTSTRAP=1 so the pinned
 *      SHA-256 hashes are regenerated in place (fail-closed otherwise),
 *   3. verifies every installer end-to-end with fresh downloads
 *      (scripts/verify-downloads.mjs, fail-closed).
 *
 * The WASM engines have no installer to re-run: package.json plus the lockfile
 * IS the pin, so bumping them is just the npm install (reviewed in the same
 * PR as the tag bumps).
 *
 * Usage:
 *   node scripts/bump-deps.mjs                # bump everything available
 *   node scripts/bump-deps.mjs 7z rar5        # only the named deps (7z 7zz rar5 snappy)
 *   node scripts/bump-deps.mjs --dry-run      # report the plan, change nothing
 *   node scripts/bump-deps.mjs --skip-verify  # skip the fresh-download verify
 *
 * Intended for local runs and the scheduled update-deps CI workflow: the
 * resulting diff (version constants + regenerated hashes) is reviewed as a
 * pull request — the hash diff IS the supply-chain review.
 *
 * The planning logic is exported and unit-tested with an injected fetchJson;
 * applyUpdates runs real installers (network + downloads) and is exercised
 * by the CI workflow, not by unit tests.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeTag, defaultFetchJson, SNAPPY_BLOCKED_VERSIONS } from "./check-updates.mjs";
import { SEVEN_ZIP_ZSTD_REPO, SEVEN_ZIP_ZSTD_TAG } from "./lib/releases.mjs";

const SCRIPTS_DIR = import.meta.dirname;
const ROOT_DIR = path.join(SCRIPTS_DIR, "..");
const RELEASES_PATH = path.join(SCRIPTS_DIR, "lib", "releases.mjs");
const ROOT_PACKAGE_JSON = path.join(ROOT_DIR, "package.json");

async function latestGithubTag(repo, fetchJson) {
  const body = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  return String(body.tag_name);
}

async function npmLatestVersion(pkgName, fetchJson) {
  const body = await fetchJson(`https://registry.npmjs.org/${pkgName}/latest`);
  return String(body.version);
}

/**
 * Rewrite one version constant inside a script (e.g.
 * `export const SEVEN_ZIP_ZSTD_TAG = "v26.02-..."`), single or double
 * quoted. Returns true when the file was updated.
 */
export function updateVersionConstant(scriptPath, constantName, newValue) {
  const text = fs.readFileSync(scriptPath, "utf8");
  const re = new RegExp(`(export\\s+const\\s+${constantName}\\s*=\\s*["'])[^"']*(["'])`);
  if (!re.test(text)) return false;
  const next = text.replace(re, `$1${newValue}$2`);
  const mode = fs.statSync(scriptPath).mode;
  fs.writeFileSync(scriptPath, next);
  fs.chmodSync(scriptPath, mode);
  return true;
}

/** Strip a leading "^" (npm caret range) for comparison. */
export function stripCaret(v) {
  return String(v).replace(/^\^/, "");
}

/**
 * One planned update:
 *   key        — "7z" | "7zz" | "rar5" | "snappy"
 *   name       — human-readable label
 *   current    — pinned/declared version today
 *   latest     — version to bump to
 *   kind       — "tag" (version constant in releases.mjs) | "npm"
 *   pkg        — (npm) package name to `npm install <pkg>@<latest>`
 *   installers — installer scripts to re-run with SA_HASH_BOOTSTRAP=1
 *   file       — (tag) script containing the version constant
 *   constant   — (tag) constant name to rewrite
 *
 * @typedef {{key: string, name: string, current: string, latest: string,
 *   kind: "tag"|"npm", pkg?: string, installers: string[], file?: string,
 *   constant?: string}} BumpPlan
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

  const mirrorTag = await latestGithubTag(SEVEN_ZIP_ZSTD_REPO, fetchJson);
  if (normalizeTag(mirrorTag) !== normalizeTag(SEVEN_ZIP_ZSTD_TAG)) {
    updates.push({
      key: "7z",
      name: "7-Zip ZS (native)",
      current: SEVEN_ZIP_ZSTD_TAG,
      latest: mirrorTag,
      kind: "tag",
      file: RELEASES_PATH,
      constant: "SEVEN_ZIP_ZSTD_TAG",
      installers: ["install-7z-platforms.mjs"],
    });
  }

  const declared = readDeclaredDeps(rootPkg);

  // npm engines: package.json is the only pin, so a newer registry version is
  // the whole plan. snappy additionally stages prebuilds via its installer and
  // has a known-broken release that must never be offered.
  for (const engine of [
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
      kind: "npm",
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
 * Apply the planned updates: rewrite constants / run `npm install` for the
 * npm dep, then re-run the affected installers with SA_HASH_BOOTSTRAP=1 to
 * regenerate the pinned hashes in place. Returns a per-dep summary.
 */
export async function applyUpdates(updates, { runInstallers = true } = {}) {
  const results = [];
  for (const u of updates) {
    if (u.kind === "npm") {
      execFileSync("npm", ["install", `${u.pkg}@${u.latest}`], {
        stdio: "inherit",
        cwd: ROOT_DIR,
      });
    } else {
      const ok = updateVersionConstant(u.file, u.constant, u.latest);
      if (!ok) throw new Error(`failed to bump ${u.constant} in ${u.file}`);
    }
    if (runInstallers) {
      for (const inst of u.installers) {
        console.log(`[bump-deps] ${u.key}: staging via ${inst} (SA_HASH_BOOTSTRAP=1)`);
        execFileSync(process.execPath, [path.join(SCRIPTS_DIR, inst)], {
          stdio: "inherit",
          env: {
            ...process.env,
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
    console.log(`  ${u.name}: ${u.current} -> ${u.latest} (${u.kind})`);
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
