/**
 * Listing cache unit tests — Smart Archiver VSCode Extension
 *
 * Disk cache for wrapped-format listings: stat fast check, sha256
 * fallback on stat change, atomic snapshot writes, cleanup sweep
 * (TTL / orphan / LRU), throttled sweeping. Pure fs + crypto —
 * no gates, no vscode double.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  cacheFilePath,
  getListingCacheDir,
  hashFile,
  initListingCache,
  maybeSweepListingCache,
  pruneListingCache,
  readListingCache,
  sweepListingCache,
  writeListingCache,
} from "../src/providers/listingCache";
import { fetchFileList } from "../src/providers/fileListing";
import { createWrapped } from "./helpers";
import { tmpDir } from "./tmp";
import type { ListEntry } from "../src/engines/fileListing-core";

const ENTRIES: ListEntry[] = [
  { path: "docs", size: 0, type: "DIRECTORY" },
  { path: "docs/readme.md", size: 42, type: "REGULAR_FILE" },
  { path: "archive.tar.gz", size: 0, type: "REGULAR_FILE" },
];

function setupSource(
  dir: string,
  content = "hello listing cache\n".repeat(100),
  name = "data.bin",
): string {
  const src = path.join(dir, name);
  fs.writeFileSync(src, content);
  return src;
}

describe("cacheFilePath", () => {
  it("is deterministic per path and distinct across paths", () => {
    const a1 = cacheFilePath("/tmp/a", "/x/data.tar.gz");
    const a2 = cacheFilePath("/tmp/a", "/x/data.tar.gz");
    const b = cacheFilePath("/tmp/a", "/x/other.tar.gz");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.endsWith(".json")).toBe(true);
  });
});

describe("hashFile", () => {
  it("hashes file content deterministically", async () => {
    const td = tmpDir("sat_lc_hash_");
    const src = setupSource(td);
    expect(await hashFile(src)).toBe(await hashFile(src));
    expect(await hashFile(src)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readListingCache / writeListingCache", () => {
  it("writes a snapshot and reads it back via the stat fast check", async () => {
    const td = tmpDir("sat_lc_basic_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);

    expect(await readListingCache(cache, src)).toBeNull();

    await writeListingCache(cache, src, ENTRIES);
    const entries = await readListingCache(cache, src);
    expect(entries).toEqual(ENTRIES);

    const snap = JSON.parse(fs.readFileSync(cacheFilePath(cache, src), "utf8")) as Record<string, unknown>;
    expect(snap.v).toBe(1);
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.entries).toEqual(ENTRIES);
    expect(snap.sourcePath).toBe(src);
    expect(typeof snap.writtenAt).toBe("number");
  });

  it("write leaves no temp files behind (atomic rename)", async () => {
    const td = tmpDir("sat_lc_atomic_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    await writeListingCache(cache, src, ENTRIES);
    const leftovers = fs.readdirSync(cache).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("returns null when the source file does not exist", async () => {
    const td = tmpDir("sat_lc_missing_");
    expect(await readListingCache(td, path.join(td, "nope.tar.gz"))).toBeNull();
  });

  it("returns null on a corrupt cache file and recovers on rewrite", async () => {
    const td = tmpDir("sat_lc_corrupt_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    await writeListingCache(cache, src, ENTRIES);

    const cacheFile = cacheFilePath(cache, src);
    fs.writeFileSync(cacheFile, "{\"v\":1,\"entries\":[broken");
    expect(await readListingCache(cache, src)).toBeNull();

    await writeListingCache(cache, src, ENTRIES);
    expect(await readListingCache(cache, src)).toEqual(ENTRIES);
  });

  it("returns null on a schema-version mismatch", async () => {
    const td = tmpDir("sat_lc_version_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    await writeListingCache(cache, src, ENTRIES);
    const cacheFile = cacheFilePath(cache, src);
    const snap = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    fs.writeFileSync(cacheFile, JSON.stringify({ ...snap, v: 999 }));
    expect(await readListingCache(cache, src)).toBeNull();
  });

  it("hash fallback: mtime change with unchanged content still hits", async () => {
    const td = tmpDir("sat_lc_touch_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    await writeListingCache(cache, src, ENTRIES);

    const future = new Date(Date.now() + 5000);
    fs.utimesSync(src, future, future);
    expect(await readListingCache(cache, src)).toEqual(ENTRIES);
  });

  it("misses when content changed with the same size", async () => {
    const td = tmpDir("sat_lc_samesize_");
    const cache = path.join(td, "cache");
    const src = setupSource(td, "AAAAAAAAAAAAAAAAAAAAAAAA");
    await writeListingCache(cache, src, ENTRIES);

    fs.writeFileSync(src, "BBBBBBBBBBBBBBBBBBBBBBBB");
    // The stat fast-path keys on (size, mtimeMs): a same-size rewrite within
    // the same millisecond would keep mtimeMs equal and hit the stale cache.
    // Push mtime forward so the test asserts the CONTENT check (sha256
    // fallback), not filesystem timestamp luck.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(src, future, future);
    expect(await readListingCache(cache, src)).toBeNull();
  });

  it("misses when content changed and size differs", async () => {
    const td = tmpDir("sat_lc_sizediff_");
    const cache = path.join(td, "cache");
    const src = setupSource(td, "small");
    await writeListingCache(cache, src, ENTRIES);

    fs.writeFileSync(src, "a much larger replacement body");
    expect(await readListingCache(cache, src)).toBeNull();
  });

  it("refresh-stats rewrite after a hash hit keeps the fast path warm", async () => {
    const td = tmpDir("sat_lc_refresh_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    await writeListingCache(cache, src, ENTRIES);

    const before = JSON.parse(fs.readFileSync(cacheFilePath(cache, src), "utf8")) as {
      mtimeMs: number;
      writtenAt: number;
    };
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(src, future, future);
    expect(await readListingCache(cache, src)).toEqual(ENTRIES);

    const snap = JSON.parse(fs.readFileSync(cacheFilePath(cache, src), "utf8")) as {
      mtimeMs: number;
      writtenAt: number;
    };
    expect(snap.mtimeMs).toBe(future.getTime());
    expect(snap.writtenAt).toBeGreaterThanOrEqual(before.writtenAt);
  });
});

describe("sweepListingCache", () => {
  it("removes entries not verified within the TTL, keeps fresh ones", async () => {
    const td = tmpDir("sat_lc_ttl_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache, { recursive: true });
    const fresh = setupSource(td, "fresh content", "fresh.bin");
    const stale = setupSource(td, "stale content", "stale.bin");
    await writeListingCache(cache, fresh, ENTRIES);
    await writeListingCache(cache, stale, ENTRIES);

    const staleFile = cacheFilePath(cache, stale);
    const snap = JSON.parse(fs.readFileSync(staleFile, "utf8"));
    snap.writtenAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(staleFile, JSON.stringify(snap));

    const removed = sweepListingCache(cache);
    expect(removed).toBe(1);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(cacheFilePath(cache, fresh))).toBe(true);
  });

  it("removes orphaned entries whose source archive is gone", async () => {
    const td = tmpDir("sat_lc_orphan_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache, { recursive: true });
    const kept = setupSource(td, "kept content", "kept.bin");
    const gone = setupSource(td, "doomed content", "doomed.bin");
    await writeListingCache(cache, kept, ENTRIES);
    await writeListingCache(cache, gone, ENTRIES);

    fs.unlinkSync(gone);
    const removed = sweepListingCache(cache);
    expect(removed).toBe(1);
    expect(fs.existsSync(cacheFilePath(cache, gone))).toBe(false);
    expect(fs.existsSync(cacheFilePath(cache, kept))).toBe(true);
  });

  it("removes corrupt cache files as dead weight", async () => {
    const td = tmpDir("sat_lc_corrupt_sweep_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "dead.json"), "not json");
    expect(sweepListingCache(cache)).toBe(1);
    expect(fs.existsSync(path.join(cache, "dead.json"))).toBe(false);
  });

  it("removes stale crash leftovers but keeps fresh temp files", () => {
    const td = tmpDir("sat_lc_tmp_sweep_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache, { recursive: true });
    const oldTmp = path.join(cache, "a.json.1234.deadbeef.tmp");
    const freshTmp = path.join(cache, "b.json.1234.cafefood.tmp");
    fs.writeFileSync(oldTmp, "partial");
    fs.writeFileSync(freshTmp, "partial");
    const now = Date.now();
    fs.utimesSync(oldTmp, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
    expect(sweepListingCache(cache, now)).toBe(1);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
  });
});

describe("poisoned snapshots", () => {
  it("returns null when a snapshot has too many entries", async () => {
    const td = tmpDir("sat_lc_entries_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    const many = Array.from({ length: 100_001 }, (_, i) => ({
      path: `f${i}.txt`,
      size: 0,
      type: "REGULAR_FILE",
    }));
    await writeListingCache(cache, src, many);
    expect(await readListingCache(cache, src)).toBeNull();
  });

  it("returns null when the cache file exceeds the byte cap", async () => {
    const td = tmpDir("sat_lc_bytes_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    await writeListingCache(cache, src, ENTRIES);
    fs.truncateSync(cacheFilePath(cache, src), 64 * 1024 * 1024 + 1);
    expect(await readListingCache(cache, src)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("symlink hardening", () => {
  it("rename replaces a pre-placed symlink without touching its target", async () => {
    const td = tmpDir("sat_lc_symlink_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    const victim = path.join(td, "victim.txt");
    fs.writeFileSync(victim, "victim content");
    const cacheFile = cacheFilePath(cache, src);
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(victim, cacheFile);

    await writeListingCache(cache, src, ENTRIES);

    expect(fs.readFileSync(victim, "utf8")).toBe("victim content");
    const st = fs.lstatSync(cacheFile);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf8")).entries).toEqual(ENTRIES);
  });

  it("read treats a symlinked cache file as a miss", async () => {
    const td = tmpDir("sat_lc_symread_");
    const cache = path.join(td, "cache");
    const src = setupSource(td);
    const decoy = path.join(td, "decoy.json");
    fs.writeFileSync(
      decoy,
      JSON.stringify({
        v: 1,
        size: 0,
        mtimeMs: 0,
        sha256: "x".repeat(64),
        writtenAt: 0,
        sourcePath: src,
        entries: ENTRIES,
      }),
    );
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(decoy, cacheFilePath(cache, src));

    expect(await readListingCache(cache, src)).toBeNull();
  });
});

describe("maybeSweepListingCache", () => {
  it("sweeps on first call and throttles within the interval", () => {
    const td = tmpDir("sat_lc_throttle_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache, { recursive: true });

    // Far in the future so earlier tests' real-time sweep state is stale.
    const t0 = Date.now() + 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(cache, "a.json"), "not json");
    expect(maybeSweepListingCache(cache, t0)).toBe(1);

    expect(maybeSweepListingCache(cache, t0 + 10 * 60_000)).toBe(0);

    fs.writeFileSync(path.join(cache, "b.json"), "not json");
    expect(maybeSweepListingCache(cache, t0 + 61 * 60_000)).toBe(1);
  });
});

describe("initListingCache / pruneListingCache", () => {
  it("init creates the directory and exposes it", () => {
    const td = tmpDir("sat_lc_init_");
    const cache = path.join(td, "cache");
    initListingCache(cache);
    expect(fs.existsSync(cache)).toBe(true);
    expect(getListingCacheDir()).toBe(cache);
    if (process.platform !== "win32") {
      expect(fs.statSync(cache).mode & 0o077).toBe(0);
    }
  });

  it("prunes oldest cache files beyond the limit", async () => {
    const td = tmpDir("sat_lc_prune_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache, { recursive: true });

    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = path.join(cache, `f${i}.json`);
      fs.writeFileSync(f, "{}");
      const t = new Date(Date.now() + i * 60_000);
      fs.utimesSync(f, t, t);
      files.push(f);
    }
    fs.writeFileSync(path.join(cache, "keep.tmp"), "{}");

    const pruned = pruneListingCache(cache, 3);
    expect(pruned).toBe(2);
    const remaining = fs.readdirSync(cache).filter((f) => f.endsWith(".json")).sort();
    expect(remaining).toEqual(["f2.json", "f3.json", "f4.json"]);
    expect(fs.existsSync(path.join(cache, "keep.tmp"))).toBe(true);
  });

  it("does nothing under the limit", async () => {
    const td = tmpDir("sat_lc_prune_under_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "a.json"), "{}");
    expect(pruneListingCache(cache, 5)).toBe(0);
  });
});

describe("fetchFileList integration (wrapped-only + password guard)", () => {
  async function buildWrapped(td: string): Promise<string> {
    const buf = await createWrapped({ "a.txt": "hello\n" }, "tar.gz");
    const arc = path.join(td, "wrapped.tar.gz");
    fs.writeFileSync(arc, Buffer.from(buf));
    return arc;
  }

  it("caches a wrapped listing (no password) into the cache dir", async () => {
    const td = tmpDir("sat_lc_integ_");
    const cache = path.join(td, "cache");
    initListingCache(cache);
    try {
      const arc = await buildWrapped(td);
      const entries = await fetchFileList(arc);
      expect(entries.some((e) => e.path.endsWith("a.txt"))).toBe(true);
      const files = fs.readdirSync(cache).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
      // Second call is served from the cache (same entries, no new file).
      const again = await fetchFileList(arc);
      expect(again.map((e) => e.path)).toEqual(entries.map((e) => e.path));
      expect(fs.readdirSync(cache).filter((f) => f.endsWith(".json")).length).toBe(1);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it("never writes the cache for a password-bearing listing", async () => {
    const td = tmpDir("sat_lc_integ_pw_");
    const cache = path.join(td, "cache");
    initListingCache(cache);
    try {
      const arc = await buildWrapped(td);
      // Wrapped archives cannot be encrypted, but the !password guard must
      // hold regardless: a password-bearing listing never touches the cache
      // (the listing itself may fail — that must not write either).
      try {
        await fetchFileList(arc, "hunter2");
      } catch {
        // Listing failure is fine; the assertion is about the cache dir.
      }
      expect(fs.readdirSync(cache)).toEqual([]);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
