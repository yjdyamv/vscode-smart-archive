/**
 * test/tmp.ts — temp directory lifecycle
 *
 * The single owner of test temp directories. Creation goes through
 * tmpDir(), and every created path is registered on disk so the global
 * teardown — which runs in a different process — can sweep everything,
 * including leftovers from crashed runs and dirs created without per-test
 * cleanup. No more prefix lists to keep in sync (the old globalSetup list
 * had already drifted from the actual prefixes in use).
 *
 * Registration is sharded per process (tmp-dirs.<pid>.json): vitest runs
 * test files in parallel fork processes, and a shared read-modify-write
 * JSON file would race (lost updates → leaked dirs on Windows especially).
 * Each process owns its own file, so writes never collide; readRegistry()
 * merges every shard for the teardown sweep.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REGISTRY_DIR = path.join(__dirname, "..", "test-results");
const REGISTRY_FILE = path.join(REGISTRY_DIR, `tmp-dirs.${process.pid}.json`);

function isRegistryName(name: string): boolean {
  return name === "tmp-dirs.json" || (name.startsWith("tmp-dirs.") && name.endsWith(".json"));
}

/**
 * Create a temp directory under the OS tmpdir and register it for
 * cleanup at teardown. Prefix must start with "sat_" (or "sat"-flavored)
 * to stay under the registry.
 */
export function tmpDir(prefix = "sat_"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    // Only this process's shard is touched — no cross-process race.
    let own: string[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
      if (Array.isArray(raw)) own = raw;
    } catch {
      // First registration in this process.
    }
    own.push(dir);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(own, null, 2));
  } catch {
    // Registration is best effort — the dir still works.
  }
  return dir;
}

/** Merge every registry shard (all pids, plus any legacy single file). */
export function readRegistry(): string[] {
  const out: string[] = [];
  try {
    for (const name of fs.readdirSync(REGISTRY_DIR)) {
      if (!isRegistryName(name)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), "utf8"));
        if (Array.isArray(raw)) out.push(...raw);
      } catch {
        // Unreadable shard (torn write / concurrent run) — ignore.
      }
    }
  } catch {
    // No registry dir yet.
  }
  return out;
}

/** Remove every registered temp dir and clear the registry. */
export function sweepRegisteredDirs(): void {
  for (const dir of readRegistry()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
  try {
    for (const name of fs.readdirSync(REGISTRY_DIR)) {
      if (!isRegistryName(name)) continue;
      try {
        fs.unlinkSync(path.join(REGISTRY_DIR, name));
      } catch {
        // Best effort.
      }
    }
  } catch {
    // Best effort.
  }
}
