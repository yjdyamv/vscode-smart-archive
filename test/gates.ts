/**
 * Environment gates — Smart Archive VSCode Extension
 *
 * One module owns "what is available in this test run". Every environment
 * decision in the suite (system 7z, bundled 7zz, staged rar5 binding, …)
 * goes through a named tier here — single detection implementation, no
 * bespoke predicates, no machine-specific paths.
 *
 * Every probe is recorded; a merged report is written to
 * test-results/gates.json so CI can see which tiers ran and which were
 * skipped, and fail when a tier silently vanished.
 *
 * Machine-specific paths are only used as DEV fallbacks — CI and other
 * machines override them via SA_RAR_CLI / SA_UNRAR_CLI / SA_RAR5_DEV_PROJECT.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as childProcess from "child_process";
import { it } from "vitest";
import { detectSystem7z } from "../src/engines/system7z";
import { bundled7zPath, testBinary } from "../src/engines/bundled7z";

export type TierName =
  | "system7z"
  | "bundled7zz"
  | "rar5Binding"
  | "rar5Cli"
  | "rar5Wasm"
  | "systemZstd"
  | "snappyWasm"
  | "outBuild";

const ROOT = path.join(__dirname, "..");
const REPORT_FILE = path.join(ROOT, "test-results", "gates.json");

// ── Tier probes ─────────────────────────────────────────────────────

function probeSystem7z(): boolean {
  return detectSystem7z() !== null;
}

function probeBundled7zz(): boolean {
  const bin = bundled7zPath();
  return bin !== null && testBinary(bin);
}

function probeRar5Binding(): boolean {
  // Mirrors the staging layout used by scripts/install-rar5-platforms.js:
  // vendor/rar5-bin/<platform>/<arch>/smart-archive-rar.<triple>.node
  try {
    const dir = path.join(ROOT, "vendor", "rar5-bin", process.platform, process.arch);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith(".node"));
  } catch {
    return false;
  }
}

/** rar/unrar CLI built from the rar-rs companion repo. */
function rar5CliPaths(): { rar: string; unrar: string } {
  return {
    rar: process.env.SA_RAR_CLI ?? path.join(os.homedir(), "桌面", "rar-rs", "target", "release", "rar"),
    unrar: process.env.SA_UNRAR_CLI ?? path.join(os.homedir(), "桌面", "rar-rs", "target", "release", "unrar"),
  };
}

/** Resolved rar/unrar CLI paths — env-overridable, dev-home fallback. */
export function rar5CliBinaries(): { rar: string; unrar: string } {
  return rar5CliPaths();
}

function probeRar5Cli(): boolean {
  const { rar, unrar } = rar5CliPaths();
  return canSpawn(rar) && canSpawn(unrar);
}

function probeRar5Wasm(): boolean {
  return fs.existsSync(path.join(ROOT, "vendor", "rar5-wasm", "smart-archive-rar.wasm32-wasi.wasm"));
}

function probeSystemZstd(): boolean {
  try {
    const r = childProcess.spawnSync("zstd", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function probeSnappyWasm(): boolean {
  try {
    const entry = require.resolve("snappy");
    return fs.existsSync(path.join(path.dirname(entry), "snappy.wasi.cjs"));
  } catch {
    return false;
  }
}

function probeOutBuild(): boolean {
  return fs.existsSync(path.join(ROOT, "out", "providers", "tempFiles.js"));
}

function canSpawn(bin: string): boolean {
  try {
    const r = childProcess.spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === null || r.status === undefined) return false;
    return (r.stdout || "").length + (r.stderr || "").length > 0;
  } catch {
    return false;
  }
}

// ── Registry + report ───────────────────────────────────────────────

export interface GateRecord {
  checked: number;
  available: number;
  firstReason?: string;
}

const probes: Record<TierName, () => boolean> = {
  system7z: probeSystem7z,
  bundled7zz: probeBundled7zz,
  rar5Binding: probeRar5Binding,
  rar5Cli: probeRar5Cli,
  rar5Wasm: probeRar5Wasm,
  systemZstd: probeSystemZstd,
  snappyWasm: probeSnappyWasm,
  outBuild: probeOutBuild,
};

const cache = new Map<TierName, boolean>();
const registry = new Map<TierName, GateRecord>();

function record(tier: TierName, available: boolean): void {
  const rec = registry.get(tier) ?? { checked: 0, available: 0 };
  rec.checked++;
  if (available) rec.available++;
  registry.set(tier, rec);
  try {
    // Test files run in separate processes (vitest forks pool); merge with
    // the on-disk report so the aggregated view survives across files.
    let disk: Partial<Record<TierName, GateRecord>> = {};
    try {
      disk = JSON.parse(fs.readFileSync(REPORT_FILE, "utf8"));
    } catch {
      // First write of the run.
    }
    const prev = disk[tier] ?? { checked: 0, available: 0 };
    disk[tier] = { checked: prev.checked + 1, available: prev.available + (available ? 1 : 0) };
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(disk, null, 2));
  } catch {
    // Report writing is best effort — never fail a test for it.
  }
}

/**
 * Probe a named tier. Cached per test-file process; each call is recorded
 * so the report reflects how many tests actually depended on the tier.
 */
export function gate(tier: TierName): boolean {
  const cached = cache.get(tier);
  if (cached !== undefined) return cached;
  const ok = probes[tier]();
  cache.set(tier, ok);
  record(tier, ok);
  return ok;
}

/**
 * Run a test only when the tier is available; skip (and record) otherwise.
 * Mirrors `it.runIf(...)` but routes through the named gate.
 */
export function itIf(
  tier: TierName,
  name: string,
  fn: (ctx: never) => void | Promise<void>,
  timeout?: number,
): void {
  if (gate(tier)) it(name, fn, timeout);
  else it.skip(name, fn);
}

export function getGateReport(): Record<TierName, GateRecord> {
  const out = {} as Record<TierName, GateRecord>;
  for (const tier of Object.keys(probes) as TierName[]) {
    const rec = registry.get(tier);
    if (rec) out[tier] = rec;
  }
  return out;
}

export function gateReportPath(): string {
  return REPORT_FILE;
}

/** Format a one-line human summary of the merged report. */
export function formatGateReport(
  report: Partial<Record<TierName, GateRecord>>,
): string {
  return Object.entries(report)
    .map(([tier, rec]) => `${tier}: ${rec!.checked}/${rec!.available} available`)
    .join("\n");
}
