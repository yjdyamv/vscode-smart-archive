#!/usr/bin/env node
import { execFileSync } from "child_process";
import path from "path";
/**
 * Verify the download scripts with fresh downloads only.
 *
 * Runs every installer that still downloads, exactly as `npm run
 * stage:natives` would, but with SA_FORCE_DOWNLOAD=1 (ignores .cache/ and
 * already-staged binaries, forcing a real network download with SHA-256
 * verification).
 *
 * The 7-Zip engines no longer download: 7-Zip ZS native comes from the
 * `7zip-zstd-native` npm package (re-included into the .vsix and resolved at
 * runtime by src/engines/bundled7z.ts; `npm ci` + the declared/installed checks
 * in test/install-scripts-config.test.ts cover it) and 7-Zip ZS WASM / rar-rs
 * are npm dependencies too.
 *
 * Usage:
 *   node scripts/verify-downloads.mjs            # every downloading installer
 *   node scripts/verify-downloads.mjs snappy     # only the named ones
 */

const STEPS = [["snappy", "install-snappy-platforms.mjs", {}]];

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
