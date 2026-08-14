#!/usr/bin/env node
/**
 * npm-ci-safe.mjs — `npm ci` with automatic lock-clearing retry (Windows).
 *
 * `npm ci` empties node_modules first, and Windows refuses to unlink a
 * native binding DLL (*.node) that any process still has loaded (EPERM).
 * The prepackage:cross hook runs scripts/clear-native-locks.mjs first, but
 * a host (e.g. the VS Code oxc/oxlint extension) may respawn its language
 * server in the window between that hook and the actual unlink. This
 * wrapper retries exactly once after re-clearing the locks, so the whole
 * pipeline survives such races without manual intervention.
 *
 * Usage:
 *   node scripts/npm-ci-safe.mjs               # npm ci --ignore-scripts
 *   node scripts/npm-ci-safe.mjs --prefix webview-ui
 *
 * Exits with npm's status code (0 = success). Non-Windows: plain `npm ci`
 * (no lock problem, no retry).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const prefixIdx = args.indexOf("--prefix");
const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : undefined;

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function runCi() {
  const ciArgs = ["ci", "--ignore-scripts"];
  if (prefix) ciArgs.push("--prefix", prefix);
  // shell:true is required on Windows — spawnSync cannot execute .cmd files
  // directly. Arguments are fixed constants (no user input), so quoting is
  // not a concern here.
  const r = spawnSync(npmCmd, ciArgs, { stdio: "inherit", shell: process.platform === "win32" });
  return r.status;
}

function clearLocks() {
  const clear = path.join(path.dirname(fileURLToPath(import.meta.url)), "clear-native-locks.mjs");
  spawnSync(process.execPath, [clear], { stdio: "inherit" });
}

let status = runCi();
if (status !== 0) {
  console.log("[npm-ci-safe] npm ci failed — clearing native locks and retrying once");
  clearLocks();
  status = runCi();
}
process.exit(status ?? 1);
