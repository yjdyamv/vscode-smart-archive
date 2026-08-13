#!/usr/bin/env node
/**
 * Apply engine dependency updates detected by check-updates.mjs.
 *
 * For each dependency with a newer release this script:
 *   1. bumps the in-repo version constant (scripts/lib/releases.mjs) or the
 *      npm dependency (snappy),
 *   2. re-runs the affected installer with SA_HASH_BOOTSTRAP=1 so the pinned
 *      SHA-256 hashes are regenerated in place (fail-closed otherwise),
 *   3. verifies every installer end-to-end with fresh downloads
 *      (scripts/verify-downloads.mjs, fail-closed).
 *
 * Usage:
 *   node scripts/bump-deps.mjs                # bump everything available
 *   node scripts/bump-deps.mjs 7z rar5        # only the named deps
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
import { normalizeTag, defaultFetchJson } from "./check-updates.mjs";
import {
  SEVEN_ZIP_ZSTD_REPO,
  SEVEN_ZIP_ZSTD_TAG,
  RAR5_REPO,
  RAR5_VERSION,
} from "./lib/releases.mjs";

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
 *   key        — "7z" | "rar5" | "snappy"
 *   name       — human-readable label
 *   current    — pinned/declared version today
 *   latest     — version to bump to
 *   kind       — "tag" (version constant in releases.mjs) | "npm"
 *   installers — installer scripts to re-run with SA_HASH_BOOTSTRAP=1
 *   file       — (tag) script containing the version constant
 *   constant   — (tag) constant name to rewrite
 *
 * @typedef {{key: string, name: string, current: string, latest: string,
 *   kind: "tag"|"npm", installers: string[], file?: string,
 *   constant?: string}} BumpPlan
 */

/**
 * Compute which dependencies have a newer release. Read-only; injectable
 * fetchJson for tests; snappyRootPkg points at a package.json whose
 * dependencies.snappy is the current declaration.
 *
 * @param {{fetchJson?: Function, snappyRootPkg?: string}} [opts]
 * @returns {Promise<BumpPlan[]>}
 */
export async function planUpdates({
  fetchJson = defaultFetchJson,
  snappyRootPkg = ROOT_PACKAGE_JSON,
} = {}) {
  const updates = [];

  const mirrorTag = await latestGithubTag(SEVEN_ZIP_ZSTD_REPO, fetchJson);
  if (normalizeTag(mirrorTag) !== normalizeTag(SEVEN_ZIP_ZSTD_TAG)) {
    updates.push({
      key: "7z",
      name: "7-Zip ZS (native+wasm)",
      current: SEVEN_ZIP_ZSTD_TAG,
      latest: mirrorTag,
      kind: "tag",
      file: RELEASES_PATH,
      constant: "SEVEN_ZIP_ZSTD_TAG",
      installers: ["install-7z-platforms.mjs", "install-7zz-wasm.mjs"],
    });
  }

  const rar5Tag = await latestGithubTag(RAR5_REPO, fetchJson);
  if (normalizeTag(rar5Tag) !== RAR5_VERSION) {
    updates.push({
      key: "rar5",
      name: "rar5 binding (smart-archive-rar)",
      current: RAR5_VERSION,
      latest: normalizeTag(rar5Tag),
      kind: "tag",
      file: RELEASES_PATH,
      constant: "RAR5_VERSION",
      installers: ["install-rar5-platforms.mjs"],
    });
  }

  const snappyLatest = await npmLatestVersion("snappy", fetchJson);
  let declared = "unknown";
  if (fs.existsSync(snappyRootPkg)) {
    declared = String(
      JSON.parse(fs.readFileSync(snappyRootPkg, "utf8")).dependencies?.snappy ?? "unknown",
    );
  }
  if (declared !== "unknown" && stripCaret(declared) !== snappyLatest) {
    updates.push({
      key: "snappy",
      name: "snappy (npm)",
      current: declared,
      latest: snappyLatest,
      kind: "npm",
      installers: ["install-snappy-platforms.mjs"],
    });
  }

  return updates;
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
      execFileSync("npm", ["install", `snappy@${u.latest}`], {
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
  const only = args.filter((a) => a === "7z" || a === "rar5" || a === "snappy");

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
