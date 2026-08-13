import * as fs from "fs";
import { sweepRegisteredDirs, readRegistry } from "./tmp";

/**
 * Global vitest setup — sweeps stale temp directories from previous runs
 * and cleans up after the run.
 *
 * Directories are tracked by test/tmp.ts in test-results/tmp-dirs.<pid>.json
 * shards (one per vitest fork, so parallel processes never race on a shared
 * file); readRegistry() merges them, so the sweep is exact — the old prefix
 * list drifted out of sync with the actual prefixes in use and leaked dirs
 * silently. Gate probes use the same shard pattern (test/gates.ts) and are
 * merged into gates.json on teardown.
 */

export function setup(): void {
  const stale = readRegistry();
  sweepRegisteredDirs();
  if (stale.length > 0) {
    console.log(`tmp sweep: removed ${stale.length} stale test temp dir(s)`);
  }
  // Drop gate-report shards left by a crashed/previous run so they cannot
  // pollute this run's merged gates.json.
  cleanupGateReportShards();
}

import { gateReportPath, formatGateReport, cleanupGateReportShards } from "./gates";
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
    if (entries.length > 0) {
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
    }
  } catch {
    // Teardown must never fail the run.
  }

  // Remove the per-process shards now that the merged report is on disk.
  try {
    cleanupGateReportShards();
  } catch {
    // Best effort.
  }
}
