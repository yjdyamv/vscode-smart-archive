#!/usr/bin/env node
import { execFileSync } from "child_process";
import path from "path";
/**
 * Verify the download scripts with fresh downloads only.
 *
 * Runs every installer exactly as `npm run stage:natives` would, but with
 * SA_FORCE_DOWNLOAD=1 (ignores .cache/ and already-staged binaries, forcing
 * a real network download with SHA-256 verification) and rar5 in fail-closed
 * mode (SA_RAR5_REQUIRE=1). No manual cache cleanup needed.
 *
 * Usage:
 *   node scripts/verify-downloads.mjs              # all four installers
 *   node scripts/verify-downloads.mjs 7zz snappy   # only the named ones
 */

const STEPS = [
  ["7zz", "install-7zz-wasm.mjs", {}],
  ["snappy", "install-snappy-platforms.mjs", {}],
  ["7z", "install-7z-platforms.mjs", {}],
  ["rar5", "install-rar5-platforms.mjs", { SA_RAR5_REQUIRE: "1" }],
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
