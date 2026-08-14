/**
 * Smart extraction helpers — Smart Archive VSCode Extension
 *
 * "Smart extract" makes the extraction result match what the user actually
 * wants instead of blindly dumping the archive contents into a wrapper
 * directory:
 *
 *   - Archive with exactly ONE top-level directory (e.g. `App-1.0/`)
 *     → the wrapper directory is removed, so the user gets the contents
 *     directly (`out/readme.md`, `out/src/...`) instead of
 *     `out/App-1.0/readme.md`.
 *   - Anything else (multiple top-level entries, a single file) → left
 *     untouched; the existing behavior already lands those directly.
 *
 * Runs AFTER extraction completes, purely on the local output directory, so
 * it works identically for every engine (system 7-Zip, WASM worker, RAR).
 *
 * @module utils/smart-extract
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger-core";

/**
 * Collapse a single wrapper directory produced by extraction.
 *
 * If `outputDir` contains exactly one entry and that entry is a directory,
 * its contents are moved up into `outputDir` and the empty wrapper is
 * removed. Otherwise (multiple entries, a lone file, an empty dir) the
 * directory is left as-is.
 *
 * Collisions cannot occur: the wrapper directory holds the archive's own
 * entries and `outputDir` was empty apart from that wrapper.
 *
 * @param outputDir - Directory the archive was extracted into
 * @returns The number of entries moved (0 when nothing was collapsed)
 */
export function promoteSingleTopDirectory(outputDir: string): number {
  const entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");
  if (entries.length !== 1) return 0;

  const wrapper = path.join(outputDir, entries[0]);
  let isDir = false;
  try {
    isDir = fs.statSync(wrapper).isDirectory();
  } catch {
    return 0;
  }
  if (!isDir) return 0;

  const children = fs.readdirSync(wrapper).filter((e) => e !== "." && e !== "..");
  for (const child of children) {
    const src = path.join(wrapper, child);
    const dst = path.join(outputDir, child);
    // A plain rename is safe: `dst` cannot exist (outputDir only contained
    // the wrapper). On Windows, renameSync of a directory over an existing
    // path would fail, so an unexpected collision must not be silently
    // destructive — fail loudly instead of losing data.
    fs.renameSync(src, dst);
  }
  try {
    fs.rmdirSync(wrapper);
  } catch (err) {
    logger.warn(
      { event: "smartExtract.rmdir.failed", wrapper, err },
      "Failed to remove wrapper directory after promoting contents",
    );
  }

  logger.info({
    event: "smartExtract.promoted",
    wrapper: entries[0],
    entries: children.length,
    outputDir,
  });
  return children.length;
}
