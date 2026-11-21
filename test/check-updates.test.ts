/**
 * check-updates.mjs unit tests — Smart Archiver
 *
 * Exercises the comparison/status logic with an injected fetchJson, so no
 * network is touched: a registry/API outage must never make these tests
 * flaky, and the "unavailable" degradation is itself asserted.
 *
 * The npm engines (snappy, 7zip-zstd-wasm, @yjdyamv/rar-rs) are read from the
 * installed tree, which the fixtures below materialise in a temp dir — the
 * same `<nodeModulesDir>/<pkg>/package.json` layout the real run uses.
 *
 * @module test/check-updates
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkUpdates, hasUpdate } from "../scripts/check-updates.mjs";
import { SEVEN_ZIP_ZSTD_TAG } from "../scripts/lib/releases.mjs";
import { tmpDir } from "./tmp";

/** Fetch stub: url prefix → value (or Error to simulate failure). */
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
const githubUpstream = `https://api.github.com/repos/mcmilk/7-Zip-zstd/releases/latest`;
const npmSnappy = `https://registry.npmjs.org/snappy/latest`;
const npm7zz = `https://registry.npmjs.org/7zip-zstd-wasm/latest`;
const npmRar = `https://registry.npmjs.org/@yjdyamv/rar-rs/latest`;

/** Versions the fixtures install unless a test overrides them. */
const INSTALLED = {
  snappy: "7.3.3",
  "7zip-zstd-wasm": "26.5.0",
  "@yjdyamv/rar-rs": "0.15.3",
};

/** Materialise a fake node_modules tree and return its path. */
function installedTree(versions: Record<string, string> = INSTALLED): string {
  const dir = tmpDir("checkupd-");
  for (const [pkg, version] of Object.entries(versions)) {
    const pkgDir = path.join(dir, ...pkg.split("/"));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  }
  return dir;
}

/** Every npm engine reports the fixture versions. */
function registryStubs({ snappy = "7.3.3", sevenZipWasm = "26.5.0", rar = "0.15.3" } = {}) {
  return {
    [npmSnappy]: { version: snappy },
    [npm7zz]: { version: sevenZipWasm },
    [npmRar]: { version: rar },
  };
}

describe("checkUpdates", () => {
  it("reports up-to-date when every pin matches its upstream", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubUpstream]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      ...registryStubs(),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    expect(results.map((r) => r.key)).toEqual(["7-Zip ZS", "7zz", "rar5", "snappy"]);
    expect(results.map((r) => r.status)).toEqual(Array(4).fill("up-to-date"));
    expect(hasUpdate(results)).toBe(false);
  });

  it("flags a newer 7-Zip ZS mirror release", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: "v26.03-v1.6.0-R1" },
      ...registryStubs(),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    const seven = results.find((r) => r.key === "7-Zip ZS")!;
    expect(seven.status).toBe("update-available");
    expect(seven.latest).toBe("v26.03-v1.6.0-R1");
    expect(hasUpdate(results)).toBe(true);
  });

  it("warns when the 7-Zip mirror lags behind upstream", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubUpstream]: { tag_name: "v26.99" },
      ...registryStubs(),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    const seven = results.find((r) => r.key === "7-Zip ZS")!;
    expect(seven.status).toBe("mirror-behind-upstream");
    expect(hasUpdate(results)).toBe(true);
  });

  it("flags a newer 7-Zip ZS WASM package", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      ...registryStubs({ sevenZipWasm: "26.6.0" }),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    const wasm = results.find((r) => r.key === "7zz")!;
    expect(wasm.status).toBe("update-available");
    expect(wasm.current).toBe("26.5.0");
    expect(wasm.latest).toBe("26.6.0");
    expect(wasm.url).toBe("https://www.npmjs.com/package/7zip-zstd-wasm");
  });

  it("flags a newer rar-rs package", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      ...registryStubs({ rar: "0.16.0" }),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    const rar5 = results.find((r) => r.key === "rar5")!;
    expect(rar5.status).toBe("update-available");
    expect(rar5.current).toBe("0.15.3");
    expect(rar5.latest).toBe("0.16.0");
  });

  it("flags a newer snappy release against the installed version", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      ...registryStubs({ snappy: "7.5.0" }),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    const snappy = results.find((r) => r.key === "snappy")!;
    expect(snappy.status).toBe("update-available");
    expect(snappy.current).toBe("7.3.3");
    expect(snappy.latest).toBe("7.5.0");
  });

  it("reports a blocked snappy release (7.4.0) as blocked, not an update", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      ...registryStubs({ snappy: "7.4.0" }),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    const snappy = results.find((r) => r.key === "snappy")!;
    expect(snappy.status).toBe("blocked");
    expect(snappy.latest).toBe("7.4.0");
    expect(snappy.reason).toMatch(/snappy-wasm32-wasi/);
    expect(hasUpdate(results)).toBe(false);
  });

  it("degrades to unavailable per-check on network errors, without throwing", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: new Error("network down"),
      [npmSnappy]: new Error("network down"),
      [npm7zz]: new Error("network down"),
      [npmRar]: new Error("network down"),
    });
    const results = await checkUpdates({ fetchJson, nodeModulesDir: installedTree() });
    expect(results).toHaveLength(4);
    for (const r of results) expect(r.status).toBe("unavailable");
    expect(hasUpdate(results)).toBe(false);
  });

  it("tolerates a missing installed tree (npm engines report unavailable)", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      ...registryStubs(),
    });
    const results = await checkUpdates({
      fetchJson,
      nodeModulesDir: path.join(tmpDir("checkupd-"), "does-not-exist"),
    });
    for (const key of ["7zz", "rar5", "snappy"]) {
      expect(results.find((r) => r.key === key)!.status, key).toBe("unavailable");
    }
    expect(results.find((r) => r.key === "7-Zip ZS")!.status).toBe("up-to-date");
  });
});
