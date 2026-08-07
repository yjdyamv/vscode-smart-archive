import * as fs from "fs";
import { sweepRegisteredDirs, readRegistry } from "./tmp";

/**
 * Global vitest setup — sweeps stale temp directories from previous runs
 * and cleans up after the run.
 *
 * Directories are tracked by test/tmp.ts in test-results/tmp-dirs.json,
 * so the sweep is exact — the old prefix list drifted out of sync with
 * the actual prefixes in use and leaked dirs silently.
 */

export function setup(): void {
  const stale = readRegistry();
  sweepRegisteredDirs();
  if (stale.length > 0) {
    console.log(`tmp sweep: removed ${stale.length} stale test temp dir(s)`);
  }
}

import { gateReportPath, formatGateReport } from "./gates";
import type { GateRecord, TierName } from "./gates";

export function teardown(): void {
  // Clean up temp dirs registered during this run.
  try {
    sweepRegisteredDirs();
  } catch {
    // Best effort.
  }

  // Print the merged environment-gate report and flag tiers that were
  // checked but never available, so CI can see what was silently skipped.
  try {
    let report: Partial<Record<TierName, GateRecord>> = {};
    try {
      report = JSON.parse(fs.readFileSync(gateReportPath(), "utf8"));
    } catch {
      // No probes ran — nothing to report.
    }
    const entries = Object.entries(report) as [TierName, GateRecord][];
    if (entries.length === 0) return;
    console.log("\n===== GATE REPORT =====");
    for (const line of formatGateReport(report).split("\n")) console.log(`  ${line}`);
    const dead = entries.filter(([, rec]) => rec.checked > 0 && rec.available === 0);
    if (dead.length > 0) {
      console.log(
        "  WARNING: tiers checked but NEVER available: " +
          dead.map(([tier]) => tier).join(", ") +
          ` — report: ${gateReportPath()}`,
      );
    }
    console.log("=======================\n");
  } catch {
    // Teardown must never fail the run.
  }
}
