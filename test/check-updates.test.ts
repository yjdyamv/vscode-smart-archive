/**
 * check-updates.mjs unit tests — Smart Archive
 *
 * Exercises the comparison/status logic with an injected fetchJson, so no
 * network is touched: a registry/API outage must never make these tests
 * flaky, and the "unavailable" degradation is itself asserted.
 *
 * @module test/check-updates
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkUpdates, hasUpdate } from "../scripts/check-updates.mjs";
import {
  SEVEN_ZIP_ZSTD_TAG,
  RAR5_VERSION,
} from "../scripts/lib/releases.mjs";
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
const githubRar5 = `https://api.github.com/repos/yjdyamv/smart-archive-rar/releases/latest`;
const npmSnappy = `https://registry.npmjs.org/snappy/latest`;

function snappyPkg(version: string): string {
  const dir = tmpDir("checkupd-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "snappy", version }),
  );
  return path.join(dir, "package.json");
}

describe("checkUpdates", () => {
  it("reports up-to-date when every pin matches its upstream", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubUpstream]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.3.3" },
    });
    const results = await checkUpdates({ fetchJson, snappyPkgPath: snappyPkg("7.3.3") });
    expect(results.map((r) => r.status)).toEqual(["up-to-date", "up-to-date", "up-to-date"]);
    expect(hasUpdate(results)).toBe(false);
  });

  it("flags a newer 7-Zip ZS mirror release", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: "v26.03-v1.6.0-R1" },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.3.3" },
    });
    const results = await checkUpdates({ fetchJson, snappyPkgPath: snappyPkg("7.3.3") });
    const seven = results.find((r) => r.key === "7-Zip ZS")!;
    expect(seven.status).toBe("update-available");
    expect(seven.latest).toBe("v26.03-v1.6.0-R1");
    expect(hasUpdate(results)).toBe(true);
  });

  it("warns when the 7-Zip mirror lags behind upstream", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubUpstream]: { tag_name: "v26.99" },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.3.3" },
    });
    const results = await checkUpdates({ fetchJson, snappyPkgPath: snappyPkg("7.3.3") });
    const seven = results.find((r) => r.key === "7-Zip ZS")!;
    expect(seven.status).toBe("mirror-behind-upstream");
    expect(hasUpdate(results)).toBe(true);
  });

  it("flags a newer rar5 release", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubUpstream]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: "0.4.0" },
      [npmSnappy]: { version: "7.3.3" },
    });
    const results = await checkUpdates({ fetchJson, snappyPkgPath: snappyPkg("7.3.3") });
    const rar5 = results.find((r) => r.key === "rar5")!;
    expect(rar5.status).toBe("update-available");
    expect(rar5.latest).toBe("0.4.0");
  });

  it("flags a newer snappy release against the installed version", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubUpstream]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.5.0" },
    });
    const results = await checkUpdates({ fetchJson, snappyPkgPath: snappyPkg("7.3.3") });
    const snappy = results.find((r) => r.key === "snappy")!;
    expect(snappy.status).toBe("update-available");
    expect(snappy.current).toBe("7.3.3");
    expect(snappy.latest).toBe("7.5.0");
  });

  it("degrades to unavailable per-check on network errors, without throwing", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: new Error("network down"),
      [githubRar5]: new Error("network down"),
      [npmSnappy]: new Error("network down"),
    });
    const results = await checkUpdates({ fetchJson, snappyPkgPath: snappyPkg("7.3.3") });
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.status).toBe("unavailable");
    expect(hasUpdate(results)).toBe(false);
  });

  it("tolerates a missing snappy package.json (reports unavailable)", async () => {
    const fetchJson = makeFetchJson({
      [github7z]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubUpstream]: { tag_name: SEVEN_ZIP_ZSTD_TAG },
      [githubRar5]: { tag_name: RAR5_VERSION },
      [npmSnappy]: { version: "7.3.3" },
    });
    const results = await checkUpdates({
      fetchJson,
      snappyPkgPath: path.join(tmpDir("checkupd-"), "does-not-exist", "package.json"),
    });
    const snappy = results.find((r) => r.key === "snappy")!;
    expect(snappy.status).toBe("unavailable");
  });
});
