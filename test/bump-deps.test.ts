/**
 * bump-deps.mjs unit tests — Smart Archive
 *
 * Locks the planning/constant-rewriting logic without network: injectable
 * fetchJson covers the comparison decisions, and updateVersionConstant is
 * exercised on temp files. applyUpdates (real installers + downloads) is
 * exercised by the CI workflow, not here.
 *
 * @module test/bump-deps
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { planUpdates, updateVersionConstant, stripCaret } from "../scripts/bump-deps.mjs";
import {
  SEVEN_ZIP_ZSTD_TAG,
  RAR5_VERSION,
} from "../scripts/lib/releases.mjs";
import { tmpDir } from "./tmp";

function makeFetchJson(stubs: Record<string, unknown>) {
  return async (url: string) => {
    for (const [prefix, value] of Object.entries(stubs)) {
      if (url.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

const github7z = `https://api.github.com/repos/yjdyamv/7-Zip-zstd-native/releases/latest`;
const githubRar5 = `https://api.github.com/repos/yjdyamv/smart-archive-rar/releases/latest`;
const npmSnappy = `https://registry.npmjs.org/snappy/latest`;

function rootPkg(declared: string | undefined): string {
  const dir = tmpDir("bumpd-");
  const p = path.join(dir, "package.json");
  fs.writeFileSync(
    p,
    JSON.stringify({ name: "root", dependencies: declared ? { snappy: declared } : {} }),
  );
  return p;
}

describe("planUpdates", () => {
  it("plans nothing when every pin matches its upstream", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.3.3" },
    });
    const updates = await planUpdates({ fetchJson, snappyRootPkg: rootPkg("^7.3.3") });
    expect(updates).toEqual([]);
  });

  it("plans a 7-Zip tag bump with both installers", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: "v26.03-v1.6.0-R1" },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.3.3" },
    });
    const updates = await planUpdates({ fetchJson, snappyRootPkg: rootPkg("^7.3.3") });
    const seven = updates.find((u) => u.key === "7z")!;
    expect(seven.latest).toBe("v26.03-v1.6.0-R1");
    expect(seven.kind).toBe("tag");
    expect(seven.constant).toBe("SEVEN_ZIP_ZSTD_TAG");
    expect(seven.installers).toEqual(["install-7z-platforms.mjs", "install-7zz-wasm.mjs"]);
  });

  it("plans a rar5 version bump (normalized without the v prefix)", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: "v0.4.0" },
      [npmSnappy]: { version: "7.3.3" },
    });
    const updates = await planUpdates({ fetchJson, snappyRootPkg: rootPkg("^7.3.3") });
    const rar5 = updates.find((u) => u.key === "rar5")!;
    expect(rar5.latest).toBe("0.4.0");
    expect(rar5.constant).toBe("RAR5_VERSION");
  });

  it("plans a snappy bump when the registry is ahead of the declaration", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.5.0" },
    });
    const updates = await planUpdates({ fetchJson, snappyRootPkg: rootPkg("^7.3.3") });
    const snappy = updates.find((u) => u.key === "snappy")!;
    expect(snappy.kind).toBe("npm");
    expect(snappy.current).toBe("^7.3.3");
    expect(snappy.latest).toBe("7.5.0");
  });

  it("does not plan a snappy bump for a blocked release (7.4.0, upstream #352)", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.4.0" },
    });
    const updates = await planUpdates({ fetchJson, snappyRootPkg: rootPkg("^7.3.3") });
    expect(updates.find((u) => u.key === "snappy")).toBeUndefined();
  });

  it("ignores snappy when the declared version already matches", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.3.3" },
    });
    const updates = await planUpdates({ fetchJson, snappyRootPkg: rootPkg("7.3.3") });
    expect(updates.find((u) => u.key === "snappy")).toBeUndefined();
  });

  it("skips snappy when the root package.json is missing", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.9.9" },
    });
    const updates = await planUpdates({
      fetchJson,
      snappyRootPkg: path.join(tmpDir("bumpd-"), "missing", "package.json"),
    });
    expect(updates.find((u) => u.key === "snappy")).toBeUndefined();
  });
});

describe("updateVersionConstant", () => {
  it("rewrites a double-quoted export const", () => {
    const dir = tmpDir("bumpd-");
    const f = path.join(dir, "releases.mjs");
    fs.writeFileSync(f, 'export const SEVEN_ZIP_ZSTD_TAG = "v26.02-v1.5.7-R2";\n');
    expect(updateVersionConstant(f, "SEVEN_ZIP_ZSTD_TAG", "v26.03-x")).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toContain('SEVEN_ZIP_ZSTD_TAG = "v26.03-x"');
  });

  it("rewrites a single-quoted const", () => {
    const dir = tmpDir("bumpd-");
    const f = path.join(dir, "releases.mjs");
    fs.writeFileSync(f, "export const RAR5_VERSION = '0.3.2';\n");
    expect(updateVersionConstant(f, "RAR5_VERSION", "0.4.0")).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toContain("RAR5_VERSION = '0.4.0'");
  });

  it("returns false when the constant does not exist", () => {
    const dir = tmpDir("bumpd-");
    const f = path.join(dir, "releases.mjs");
    fs.writeFileSync(f, "export const OTHER = 'x';\n");
    expect(updateVersionConstant(f, "MISSING", "y")).toBe(false);
    expect(fs.readFileSync(f, "utf8")).toContain("OTHER = 'x'");
  });
});

describe("stripCaret", () => {
  it("strips a leading caret only", () => {
    expect(stripCaret("^7.3.3")).toBe("7.3.3");
    expect(stripCaret("7.3.3")).toBe("7.3.3");
  });
});
