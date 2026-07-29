import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Global vitest setup — cleans stale temp directories from previous
 * test runs before the test suite starts.  Prevents fs.writeFileSync
 * failures caused by accumulated test artifacts (e.g. ENOSPC, inode
 * exhaustion on tmpfs).
 */
export function setup(): void {
  const tmp = os.tmpdir();
  // All temp directory prefixes used by test helpers and test files.
  const prefixes = [
    "sat_",      // general short-lived tests
    "sa_test_",  // compress-decompress
    "saa_",      // system7z add
    "sab_",      // preview brotli
    "sal_",      // lz4
    "sas_",      // snappy
    "saz_",      // zstd
    "svt_",      // split-volume tests
    "tcomp_",    // testCompress helper
    "tdec_",     // testDecompress helper
  ];

  for (const prefix of prefixes) {
    try {
      const entries = fs.readdirSync(tmp);
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          const full = path.join(tmp, entry);
          try {
            fs.rmSync(full, { recursive: true, force: true });
          } catch {
            // Best effort — another process may hold a lock
          }
        }
      }
    } catch {
      // tmpdir not readable — skip
    }
  }
}
