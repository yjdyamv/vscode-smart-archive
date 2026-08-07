import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

import { mapLimit } from "../scripts/lib/async";
import { countStatuses, downloadWithCache } from "../scripts/lib/download";
import { extractNodeFromTgz, findFileInTree } from "../scripts/lib/archive";
import { sha256 } from "../scripts/lib/hash-pins";
import { tmpDir } from "./tmp";

/** Build a minimal ustar entry for tests. */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

describe("mapLimit", () => {
  it("preserves order and never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBe(2);
  });

  it("handles an empty item list", async () => {
    await expect(mapLimit([], 3, async () => 1)).resolves.toEqual([]);
  });
});

describe("countStatuses", () => {
  it("groups downloadWithCache statuses into the run summary", () => {
    expect(
      countStatuses(["downloaded", "cached", "skipped", "failed", "downloaded"]),
    ).toEqual({ installed: 2, cached: 1, skipped: 1, failed: 1 });
  });
});

describe("downloadWithCache force mode", () => {
  it("re-downloads even when dest and cache already match the pinned hash", async () => {
    process.env.SA_FORCE_DOWNLOAD = "1";
    const dir = tmpDir("sa-force-");
    try {
      const cacheDir = path.join(dir, "cache");
      const destPath = path.join(dir, "out.bin");
      const data = Buffer.from("fresh-bytes");
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "key"), data);
      fs.writeFileSync(destPath, data);

      let fetches = 0;
      const result = await downloadWithCache({
        cacheDir,
        cacheKey: "key",
        destPath,
        expectedSha256: sha256(data),
        requireHash: true,
        label: "force",
        fetch: async () => {
          fetches++;
          return data;
        },
      });

      expect(fetches).toBe(1);
      expect(result.status).toBe("downloaded");
    } finally {
      delete process.env.SA_FORCE_DOWNLOAD;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findFileInTree", () => {
  it("finds a file recursively by basename", () => {
    const dir = tmpDir("sa-find-");
    try {
      const nested = path.join(dir, "a", "b");
      fs.mkdirSync(nested, { recursive: true });
      const target = path.join(nested, "target.bin");
      fs.writeFileSync(target, "x");
      expect(findFileInTree(dir, "target.bin")).toBe(target);
      expect(findFileInTree(dir, "missing.bin")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractNodeFromTgz", () => {
  it("extracts the first .node file from a gzipped npm tarball", () => {
    const payload = Buffer.from("node-bytes");
    const tar = Buffer.concat([
      tarEntry("package/snappy.linux-x64-gnu.node", payload),
      Buffer.alloc(1024),
    ]);
    const tgz = zlib.gzipSync(tar);
    expect(extractNodeFromTgz(zlib.gunzipSync(tgz))).toEqual(payload);
  });

  it("returns null when the tarball has no .node file", () => {
    const tar = Buffer.concat([
      tarEntry("package/README.md", Buffer.from("readme")),
      Buffer.alloc(1024),
    ]);
    const tgz = zlib.gzipSync(tar);
    expect(extractNodeFromTgz(zlib.gunzipSync(tgz))).toBeNull();
  });
});
