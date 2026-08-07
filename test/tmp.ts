/**
 * test/tmp.ts — temp directory lifecycle
 *
 * The single owner of test temp directories. Creation goes through
 * tmpDir(), and every created path is registered on disk
 * (test-results/tmp-dirs.json) so the global teardown — which runs in a
 * different process — can sweep everything, including leftovers from
 * crashed runs and dirs created without per-test cleanup. No more
 * prefix lists to keep in sync (the old globalSetup list had already
 * drifted from the actual prefixes in use).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REGISTRY_FILE = path.join(__dirname, "..", "test-results", "tmp-dirs.json");

/**
 * Create a temp directory under the OS tmpdir and register it for
 * cleanup at teardown. Prefix must start with "sat_" (or "sat"-flavored)
 * to stay under the registry.
 */
export function tmpDir(prefix = "sat_"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    const existing = readRegistry();
    existing.push(dir);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(existing, null, 2));
  } catch {
    // Registration is best effort — the dir still works.
  }
  return dir;
}

export function readRegistry(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
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
    fs.writeFileSync(REGISTRY_FILE, "[]");
  } catch {
    // Best effort.
  }
}
