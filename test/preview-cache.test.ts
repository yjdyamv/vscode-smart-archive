/**
 * Preview cache unit tests — Smart Archive VSCode Extension
 *
 * Persistent single-file preview cache: deterministic keying on
 * archive path + mtime + size + entry, atomic O_EXCL stores, and the
 * TTL / count / byte sweep. Pure fs + crypto — no gates.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  getPreviewCacheDir,
  initPreviewCache,
  previewCachePath,
  storePreviewCache,
  sweepPreviewCache,
} from "../src/providers/previewCache";
import { secureUnlink } from "../src/utils/fs";
import { tmpDir } from "./tmp";

let dir: string;

beforeAll(() => {
  dir = tmpDir("sat_pvcunit_");
  initPreviewCache(dir);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("previewCachePath", () => {
  it("is deterministic per key and distinct across archives/entries", () => {
    const a1 = previewCachePath("/x/a.7z", 1.5, 100, "dir/f.txt", ".txt");
    const a2 = previewCachePath("/x/a.7z", 1.5, 100, "dir/f.txt", ".txt");
    expect(a1).toBe(a2);
    expect(a1).toMatch(/[0-9a-f]{16}\.txt$/);
    expect(a1).not.toBe(previewCachePath("/x/b.7z", 1.5, 100, "dir/f.txt", ".txt"));
    expect(a1).not.toBe(previewCachePath("/x/a.7z", 2.0, 100, "dir/f.txt", ".txt"));
    expect(a1).not.toBe(previewCachePath("/x/a.7z", 1.5, 200, "dir/f.txt", ".txt"));
    expect(a1).not.toBe(previewCachePath("/x/a.7z", 1.5, 100, "dir/g.txt", ".txt"));
  });
});

describe("storePreviewCache", () => {
  it("stores atomically without leaving temp files", async () => {
    const target = path.join(dir, "store1.bin");
    await storePreviewCache(target, Buffer.from("preview bytes"));
    expect(fs.readFileSync(target, "utf8")).toBe("preview bytes");
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("overwrites atomically on repeat stores (same key implies identical bytes)", async () => {
    const target = path.join(dir, "store2.bin");
    await storePreviewCache(target, Buffer.from("identical"));
    await storePreviewCache(target, Buffer.from("identical"));
    expect(fs.readFileSync(target, "utf8")).toBe("identical");
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("sweepPreviewCache", () => {
  it("removes TTL-expired files and keeps fresh ones", async () => {
    const td = tmpDir("sat_pvc_sweep_");
    const oldFile = path.join(td, "old.bin");
    const freshFile = path.join(td, "fresh.bin");
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(freshFile, "fresh");
    const now = Date.now();
    fs.utimesSync(oldFile, new Date(now - 31 * 24 * 60 * 60 * 1000), new Date(now - 31 * 24 * 60 * 60 * 1000));

    expect(sweepPreviewCache(td, now)).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    fs.rmSync(td, { recursive: true, force: true });
  });

  it("prunes by count (LRU) and by total bytes", async () => {
    const td = tmpDir("sat_pvc_prune_");
    // bytes cap (1 GiB) can't be hit cheaply — exercise the count cap via
    // many small files, and the byte cap via a few large files.
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(td, `f${i}.bin`), "x".repeat(10));
    }
    const removed = sweepPreviewCache(td);
    expect(removed).toBe(0); // 10 < 100 and tiny bytes — nothing pruned

    // Simulate the byte cap: 110 files of 10 MiB each = 1.1 GiB.
    const big = tmpDir("sat_pvc_bytes_");
    for (let i = 0; i < 110; i++) {
      fs.writeFileSync(path.join(big, `b${i}.bin`), Buffer.alloc(10 * 1024 * 1024, 1));
    }
    const removedBig = sweepPreviewCache(big);
    expect(removedBig).toBeGreaterThan(0);
    const remaining = fs.readdirSync(big).length;
    const totalBytes = fs
      .readdirSync(big)
      .reduce((sum, f) => sum + fs.statSync(path.join(big, f)).size, 0);
    expect(totalBytes).toBeLessThanOrEqual(1024 * 1024 * 1024);
    expect(remaining).toBeLessThan(110);
    fs.rmSync(td, { recursive: true, force: true });
    fs.rmSync(big, { recursive: true, force: true });
  });

  it("cleans stale crash leftovers (.tmp older than the sweep interval)", async () => {
    const td = tmpDir("sat_pvc_tmp_");
    const stale = path.join(td, "a.bin.1.abc.tmp");
    fs.writeFileSync(stale, "partial");
    const now = Date.now() + 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
    expect(sweepPreviewCache(td, now)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    fs.rmSync(td, { recursive: true, force: true });
  });
});

describe("secureUnlink", () => {
  it("removes the file and tolerates missing files", () => {
    const f = path.join(dir, "secure.bin");
    fs.writeFileSync(f, "sensitive preview content");
    secureUnlink(f);
    expect(fs.existsSync(f)).toBe(false);
    expect(() => secureUnlink(path.join(dir, "does-not-exist.bin"))).not.toThrow();
  });

  it("never follows symlinks (removes the link itself)", () => {
    if (process.platform === "win32") return;
    const victim = path.join(dir, "victim.bin");
    const link = path.join(dir, "link.bin");
    fs.writeFileSync(victim, "do not touch");
    fs.symlinkSync(victim, link);
    secureUnlink(link);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("do not touch");
  });
});

describe("initPreviewCache", () => {
  it("creates the directory and exposes it", () => {
    const td = tmpDir("sat_pvc_init_");
    const cache = path.join(td, "cache");
    initPreviewCache(cache);
    expect(fs.existsSync(cache)).toBe(true);
    expect(getPreviewCacheDir()).toBe(cache);
    if (process.platform !== "win32") {
      expect(fs.statSync(cache).mode & 0o077).toBe(0);
    }
    fs.rmSync(td, { recursive: true, force: true });
  });
});
