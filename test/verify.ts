/**
 * test/verify.ts — archive verification interface
 *
 * Deep verification behind small calls. The strongest assertion pattern in
 * this suite is the content round-trip: extract the archive with the
 * INDEPENDENT oracle (raw 7zz WASM CLI — never production compression
 * logic) and compare every entry byte-for-byte. Tests that stop at
 * exit-code / file-size / `expect(true)` are exactly the weak spot this
 * module replaces: the standard is "every mutation is followed by an
 * observable outcome check".
 *
 * The oracle cannot read RAR5 (the WASM 7zz is RAR-less); for rar5 use
 * verifyArchiveWith7zz, which extracts through the bundled full-format
 * 7zz binary (gated by the caller).
 */

import { expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";
import { j7zDecompress } from "./helpers";
import { bundled7zPath } from "../src/engines/bundled7z";
import { tmpDir } from "./tmp";

/**
 * Assert the archive bytes extract exactly to `expected` (path → content).
 * Also asserts the entry set matches — extra or missing files fail.
 */
export async function verifyArchiveContents(
  buf: Buffer,
  expected: Record<string, string>,
): Promise<void> {
  const actual = await j7zDecompress(buf);
  const actualKeys = Object.keys(actual).sort();
  expect(actualKeys, `entry set mismatch (got: ${actualKeys.join(", ")})`).toEqual(
    Object.keys(expected).sort(),
  );
  for (const [entry, content] of Object.entries(expected)) {
    expect(actual[entry], `content mismatch for ${entry}`).toBe(content);
  }
}

/**
 * Assert the archive at `filePath` (RAR5 or any format the bundled 7zz
 * reads) extracts exactly to `expected`. Uses the bundled binary as an
 * independent oracle; callers must gate on `gate("bundled7zz")`.
 */
export async function verifyArchiveWith7zz(
  filePath: string,
  expected: Record<string, string>,
): Promise<void> {
  const bin = bundled7zzForVerify();
  const tmp = tmpDir("sat_verify-");
  try {
    const out = path.join(tmp, "out");
    fs.mkdirSync(out);
    const r = childProcess.execFileSync(bin, ["x", `-o${out}`, filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(r).toContain("Everything is Ok");

    const actual: Record<string, string> = {};
    const walk = (dir: string, prefix: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        if (fs.statSync(fp).isDirectory()) walk(fp, rel);
        else actual[rel] = fs.readFileSync(fp, "utf8");
      }
    };
    walk(out, "");

    expect(Object.keys(actual).sort(), `entry set mismatch (got: ${Object.keys(actual).join(", ")})`).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [entry, content] of Object.entries(expected)) {
      expect(actual[entry], `content mismatch for ${entry}`).toBe(content);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let _bundled7zz: string | null | undefined;
function bundled7zzForVerify(): string {
  if (_bundled7zz !== undefined) return _bundled7zz;
  _bundled7zz = bundled7zPath();
  if (_bundled7zz === null) throw new Error("bundled 7zz not available");
  return _bundled7zz;
}
