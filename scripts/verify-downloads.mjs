#!/usr/bin/env node
import { execFileSync } from "child_process";
import path from "path";
/**
 * Verify the download scripts with fresh downloads only.
 *
 * Runs every remaining installer exactly as `npm run stage:natives` would, but
 * with SA_FORCE_DOWNLOAD=1 (ignores .cache/ and already-staged binaries,
 * forcing a real network download with SHA-256 verification). The WASM engines
 * (7zz, rar5) are npm dependencies and are verified by `npm ci` instead.
 *
 * Usage:
 *   node scripts/verify-downloads.mjs              # every installer
 *   node scripts/verify-downloads.mjs 7z snappy    # only the named ones
 */

const STEPS = [
  ["snappy", "install-snappy-platforms.mjs", {}],
  ["7z", "install-7z-platforms.mjs", {}],
];

const args = process.argv.slice(2);
const selected = args.length === 0 ? STEPS : STEPS.filter(([name]) => args.includes(name));

if (selected.length === 0) {
  console.error(
    `unknown installer(s): ${args.join(", ")}\n` +
      `available: ${STEPS.map(([name]) => name).join(", ")}`,
  );
  process.exit(2);
}

for (const [name, file, extraEnv] of selected) {
  console.log(`\n=== verify ${name}: ${file} (fresh download) ===`);
  try {
    execFileSync(process.execPath, [path.join(import.meta.dirname, file)], {
      stdio: "inherit",
      env: { ...process.env, SA_FORCE_DOWNLOAD: "1", ...extraEnv },
    });
  } catch (err) {
    console.error(`\n[verify-downloads] ${name} FAILED (exit ${err.status ?? "unknown"})`);
    process.exit(1);
  }
}

console.log("\n=== verify-downloads: all installers passed with fresh downloads ===");
