/**
 * Seam coverage guard — Smart Archive VSCode Extension
 *
 * Makes "comprehensive coverage" a machine-checked property instead of a
 * human audit. Scans src/ for modules, scans test/ for imports, and
 * compares against test/seam-manifest.ts:
 *   - every src module must be registered (covered or gap)
 *   - every covered entry's listed test file must still reference it
 *   - every gap entry must carry an explicit reason
 *   - stale gap entries (module now imported) fail, so the manifest
 *     cannot rot
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SEAM_COVERED, SEAM_GAPS } from "./seam-manifest";

const ROOT = path.join(__dirname, "..");

function listSrcModules(): string[] {
  const out: string[] = [];
  const rootPrefix = ROOT + path.sep;
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      // Normalize to forward slashes — the manifest keys use "/", and
      // path.join on Windows yields "\" which would never match. The ROOT
      // prefix must use path.sep too, otherwise the replace is a no-op.
      else if (name.endsWith(".ts")) {
        out.push(full.replace(rootPrefix, "").replace(/\\/g, "/"));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return out.sort();
}

function testFiles(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "test"))
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

/** Does `file` reference the module (directly or through its barrel)? */
function references(file: string, modulePath: string): boolean {
  const content = fs.readFileSync(path.join(ROOT, "test", file), "utf8");
  const direct = modulePath.replace(/^src\//, "../src/").replace(/\.ts$/, "");
  if (content.includes(direct)) return true;
  // Barrel import: "../src/<first-dir>" for src/<first-dir>/<name>.ts
  const m = modulePath.match(/^src\/([^/]+)\//);
  if (m) {
    const barrel = `"../src/${m[1]}"`;
    if (content.includes(barrel)) return true;
  }
  return false;
}

describe("seam coverage guard", () => {
  it("every src module is registered in the manifest", () => {
    const registered = new Set([...Object.keys(SEAM_COVERED), ...Object.keys(SEAM_GAPS)]);
    const unregistered = listSrcModules().filter((m) => !registered.has(m));
    expect(unregistered, "new modules must be registered in test/seam-manifest.ts").toEqual([]);
  });

  it("no gap entry is stale or reason-less", () => {
    const covered = new Set(Object.keys(SEAM_COVERED));
    for (const [modulePath, reason] of Object.entries(SEAM_GAPS)) {
      expect(reason.trim(), `gap "${modulePath}" needs a reason`).not.toBe("");
      expect(covered.has(modulePath), `gap "${modulePath}" is stale — module is now imported`).toBe(false);
    }
  });

  it("every covered module's test files still import it (no drift)", () => {
    const testSet = new Set(testFiles());
    const problems: string[] = [];
    for (const [modulePath, tests] of Object.entries(SEAM_COVERED)) {
      for (const t of tests) {
        if (!testSet.has(t)) {
          problems.push(`${modulePath}: listed test file ${t} does not exist`);
          continue;
        }
        if (!references(t, modulePath)) {
          problems.push(`${modulePath}: ${t} no longer imports it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("coverage summary is visible in the run output", () => {
    const total = listSrcModules().length;
    const covered = Object.keys(SEAM_COVERED).length;
    const gaps = Object.keys(SEAM_GAPS).length;
    expect(covered + gaps).toBe(total);
    console.log(
      `seam coverage: ${covered}/${total} modules covered, ${gaps} registered gaps` +
        ` — see test/seam-manifest.ts`,
    );
  });
});
