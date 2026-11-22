/**
 * bump-deps.mjs unit tests — Smart Archiver
 *
 * Locks the planning logic without network: an injectable fetchJson covers the
 * comparison decisions. Every engine is an npm dependency now, so there is no
 * version constant left to rewrite. applyUpdates (real npm installs +
 * downloads) is exercised by the CI workflow, not here.
 *
 * @module test/bump-deps
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { planUpdates, stripCaret } from "../scripts/bump-deps.mjs";
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

const npm7zNative = `https://registry.npmjs.org/7zip-zstd-native/latest`;
const npmSnappy = `https://registry.npmjs.org/snappy/latest`;
const npm7zz = `https://registry.npmjs.org/7zip-zstd-wasm/latest`;
const npmRar = `https://registry.npmjs.org/@yjdyamv/rar-rs/latest`;

/** Declared dependency versions the fixtures start from. */
const DECLARED = {
  "7zip-zstd-native": "^26.5.0",
  snappy: "^7.3.3",
  "7zip-zstd-wasm": "^26.5.0",
  "@yjdyamv/rar-rs": "^0.15.3",
};

function rootPkg(deps: Record<string, string> = DECLARED): string {
  const dir = tmpDir("bumpd-");
  const p = path.join(dir, "package.json");
  fs.writeFileSync(p, JSON.stringify({ name: "root", dependencies: deps }));
  return p;
}

/** Registry stubs that match the declared versions. */
function npmStubs({
  sevenZipNative = "26.5.0",
  snappy = "7.3.3",
  sevenZipWasm = "26.5.0",
  rar = "0.15.3",
} = {}) {
  return {
    [npm7zNative]: { version: sevenZipNative },
    [npmSnappy]: { version: snappy },
    [npm7zz]: { version: sevenZipWasm },
    [npmRar]: { version: rar },
  };
}

describe("planUpdates", () => {
  it("plans nothing when every pin matches its upstream", async () => {
    const fetchJson = makeFetchJson({ ...npmStubs() });
    const updates = await planUpdates({ fetchJson, rootPkg: rootPkg() });
    expect(updates).toEqual([]);
  });

  it("plans a 7-Zip ZS native npm bump with no installer to re-run", async () => {
    const fetchJson = makeFetchJson({ ...npmStubs({ sevenZipNative: "26.6.0" }) });
    const updates = await planUpdates({ fetchJson, rootPkg: rootPkg() });
    const seven = updates.find((u) => u.key === "7z")!;
    expect(seven.pkg).toBe("7zip-zstd-native");
    expect(seven.current).toBe("^26.5.0");
    expect(seven.latest).toBe("26.6.0");
    expect(seven.installers).toEqual([]);
  });

  it("plans the 7-Zip ZS WASM package bump via npm, with no installer to re-run", async () => {
    const fetchJson = makeFetchJson({ ...npmStubs({ sevenZipWasm: "26.6.0" }) });
    const updates = await planUpdates({ fetchJson, rootPkg: rootPkg() });
    const wasm = updates.find((u) => u.key === "7zz")!;
    expect(wasm.pkg).toBe("7zip-zstd-wasm");
    expect(wasm.current).toBe("^26.5.0");
    expect(wasm.latest).toBe("26.6.0");
    expect(wasm.installers).toEqual([]);
  });

  it("plans a rar-rs npm bump", async () => {
    const fetchJson = makeFetchJson({ ...npmStubs({ rar: "0.16.0" }) });
    const updates = await planUpdates({ fetchJson, rootPkg: rootPkg() });
    const rar5 = updates.find((u) => u.key === "rar5")!;
    expect(rar5.pkg).toBe("@yjdyamv/rar-rs");
    expect(rar5.current).toBe("^0.15.3");
    expect(rar5.latest).toBe("0.16.0");
    expect(rar5.installers).toEqual([]);
  });

  it("plans a snappy bump when the registry is ahead of the declaration", async () => {
    const fetchJson = makeFetchJson({ ...npmStubs({ snappy: "7.5.0" }) });
    const updates = await planUpdates({ fetchJson, rootPkg: rootPkg() });
    const snappy = updates.find((u) => u.key === "snappy")!;
    expect(snappy.pkg).toBe("snappy");
    expect(snappy.current).toBe("^7.3.3");
    expect(snappy.latest).toBe("7.5.0");
    expect(snappy.installers).toEqual(["install-snappy-platforms.mjs"]);
  });

  it("does not plan a snappy bump for a blocked release (7.4.0, upstream #352)", async () => {
    const fetchJson = makeFetchJson({ ...npmStubs({ snappy: "7.4.0" }) });
    const updates = await planUpdates({ fetchJson, rootPkg: rootPkg() });
    expect(updates.find((u) => u.key === "snappy")).toBeUndefined();
  });

  it("ignores snappy when the declared version already matches", async () => {
    const fetchJson = makeFetchJson({ ...npmStubs() });
    const updates = await planUpdates({ fetchJson, rootPkg: rootPkg({ snappy: "7.3.3" }) });
    expect(updates.find((u) => u.key === "snappy")).toBeUndefined();
  });

  it("skips every npm engine when the root package.json is missing", async () => {
    const fetchJson = makeFetchJson({
      ...npmStubs({
        snappy: "7.9.9",
        sevenZipWasm: "26.9.9",
        rar: "0.99.0",
        sevenZipNative: "27.0.0",
      }),
    });
    const updates = await planUpdates({
      fetchJson,
      rootPkg: path.join(tmpDir("bumpd-"), "missing", "package.json"),
    });
    expect(updates.map((u) => u.key)).toEqual([]);
  });
});

describe("stripCaret", () => {
  it("strips a leading caret only", () => {
    expect(stripCaret("^7.3.3")).toBe("7.3.3");
    expect(stripCaret("7.3.3")).toBe("7.3.3");
  });
});
