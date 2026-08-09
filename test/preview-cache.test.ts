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
  clearPreviewCache,
  previewCacheHit,
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

describe("previewCacheHit", () => {
  it("accepts a stored regular file", async () => {
    const target = path.join(dir, "hit1.bin");
    await storePreviewCache(target, Buffer.from("ok"));
    expect(previewCacheHit(target)).toBe(true);
  });

  it("refuses a planted symlink (would open the attacker's file in the editor)", async () => {
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "attacker-chosen content");
    const target = path.join(dir, "hit2.bin");
    fs.symlinkSync(victim, target);
    expect(previewCacheHit(target)).toBe(false);
  });

  it("refuses a FIFO (would hang the editor read)", async () => {
    const target = path.join(dir, "hit3.bin");
    await new Promise<void>((resolve, reject) => {
      const mk = require("child_process").spawn("mkfifo", [target]);
      mk.on("exit", (code: number) => (code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`))));
    });
    expect(previewCacheHit(target)).toBe(false);
    try {
      secureUnlink(target);
    } catch {
      // Best effort — the dir is cleaned up by tmpDir teardown.
    }
  });

  it("refuses an oversized tampered file", async () => {
    const target = path.join(dir, "hit4.bin");
    await storePreviewCache(target, Buffer.from("small"));
    fs.writeFileSync(target, Buffer.alloc(100 * 1024 * 1024 + 1));
    expect(previewCacheHit(target)).toBe(false);
  });

  it("is false for a missing file", () => {
    expect(previewCacheHit(path.join(dir, "nope.bin"))).toBe(false);
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
    initPreviewCache(dir); // restore the module-level cache dir
  });

  it("accepts an injected config reader and applies it live", () => {
    const td = tmpDir("sat_pvc_cfg_");
    const cache = path.join(td, "cache");
    let maxFiles = 5;
    initPreviewCache(cache, () => ({ maxFiles }));
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(cache, `f${i}.bin`), "x".repeat(10));
    }
    expect(sweepPreviewCache(cache)).toBe(5); // pruned to the injected cap
    expect(fs.readdirSync(cache).length).toBe(5);

    // Live change applies on the next sweep.
    maxFiles = 2;
    expect(sweepPreviewCache(cache)).toBe(3);
    expect(fs.readdirSync(cache).length).toBe(2);
    fs.rmSync(td, { recursive: true, force: true });
    initPreviewCache(dir); // restore the module-level cache dir
  });
});

describe("content-addressed dedup", () => {
  it("hardlinks identical bytes to the first stored copy", async () => {
    const a = path.join(dir, "dedup_a.bin");
    const b = path.join(dir, "dedup_b.bin");
    const data = Buffer.from("the same preview bytes, twice");
    await storePreviewCache(a, data);
    await storePreviewCache(b, data);

    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    expect(sa.ino).toBe(sb.ino); // same inode — one copy on disk
    expect(sa.nlink).toBe(2);
    expect(fs.readFileSync(a, "utf8")).toBe(fs.readFileSync(b, "utf8"));
  });

  it("stores distinct content as separate inodes", async () => {
    const a = path.join(dir, "dedup_x.bin");
    const b = path.join(dir, "dedup_y.bin");
    await storePreviewCache(a, Buffer.from("aaaa"));
    await storePreviewCache(b, Buffer.from("bbbb"));
    expect(fs.statSync(a).ino).not.toBe(fs.statSync(b).ino);
  });

  it("recovers when the indexed target disappears (plain write)", async () => {
    const a = path.join(dir, "dedup_r_a.bin");
    const b = path.join(dir, "dedup_r_b.bin");
    const data = Buffer.from("recover me");
    await storePreviewCache(a, data);
    // Tamper: delete the indexed copy, then store the same bytes again.
    secureUnlink(a);
    await storePreviewCache(b, data);
    expect(fs.readFileSync(b, "utf8")).toBe("recover me");
    expect(fs.statSync(b).nlink).toBe(1);
  });

  it("ignores a corrupt or oversized manifest", async () => {
    const a = path.join(dir, "dedup_c_a.bin");
    const b = path.join(dir, "dedup_c_b.bin");
    fs.writeFileSync(path.join(dir, "index.json"), "{ not json !!!");
    const data = Buffer.from("corrupt manifest");
    await storePreviewCache(a, data);
    // The index self-heals: the first store rebuilds it, so the second
    // store of identical bytes dedups again.
    await storePreviewCache(b, data);
    expect(fs.readFileSync(a, "utf8")).toBe("corrupt manifest");
    expect(fs.readFileSync(b, "utf8")).toBe("corrupt manifest");
    expect(fs.statSync(b).nlink).toBe(2);
  });

  it("a manifest entry that escapes the cache dir is ignored", async () => {
    const a = path.join(dir, "dedup_e_a.bin");
    const b = path.join(dir, "dedup_e_b.bin");
    const data = Buffer.from("escape attempt");
    await storePreviewCache(a, data);
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({
        v: 2,
        entries: { "../../outside-target": { contentHash: sha256hex(data), archivePath: "", archiveMtimeMs: 0, archiveSize: 0 } },
      }),
    );
    // Outside link target must not be used; plain write lands correctly.
    await storePreviewCache(b, data);
    expect(fs.readFileSync(b, "utf8")).toBe("escape attempt");
  });

  it("the sweep keeps the manifest and rebuilds it when entries are pruned", async () => {
    const td = tmpDir("sat_pvc_dedupsweep_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache);
    const f1 = path.join(cache, "s1.bin");
    const f2 = path.join(cache, "s2.bin");
    const data = Buffer.from("sweep me");
    initPreviewCache(cache, () => ({ maxFiles: 1, maxBytes: 1024 * 1024, ttlMs: 1000 * 1000 }));
    await storePreviewCache(f1, data);
    await storePreviewCache(f2, data);
    expect(fs.statSync(f1).nlink).toBe(2);
    expect(fs.existsSync(path.join(cache, "index.json"))).toBe(true);

    // TTL-prune everything: the manifest must be dropped with the files.
    const now = Date.now() + 2 * 1000 * 1000;
    fs.utimesSync(f1, new Date(now - 3 * 1000 * 1000), new Date(now - 3 * 1000 * 1000));
    fs.utimesSync(f2, new Date(now - 3 * 1000 * 1000), new Date(now - 3 * 1000 * 1000));
    expect(sweepPreviewCache(cache, now)).toBe(2);
    expect(fs.readdirSync(cache).filter((n) => n.endsWith(".json"))).toEqual([]);
    fs.rmSync(td, { recursive: true, force: true });
    initPreviewCache(dir); // restore the module-level cache dir
  });

  it("the byte budget counts deduplicated copies once", async () => {
    const td = tmpDir("sat_pvc_dedupbytes_");
    const cache = path.join(td, "cache");
    fs.mkdirSync(cache);
    const f1 = path.join(cache, "b1.bin");
    const f2 = path.join(cache, "b2.bin");
    const data = Buffer.alloc(1024, 9);
    initPreviewCache(cache, () => ({ maxFiles: 100, maxBytes: 1536, ttlMs: 1000 * 1000 }));
    await storePreviewCache(f1, data);
    await storePreviewCache(f2, data); // hardlink — same inode
    // Unique bytes = 1024 <= 1536, so the budget is NOT exceeded; a naive
    // per-file sum (2048) would prune one.
    expect(sweepPreviewCache(cache)).toBe(0);
    expect(fs.existsSync(f1)).toBe(true);
    expect(fs.existsSync(f2)).toBe(true);
    fs.rmSync(td, { recursive: true, force: true });
    initPreviewCache(dir); // restore the module-level cache dir
  });
});

describe("orphan reclamation (origins index)", () => {
  function setup(tag: string): { td: string; cache: string; arc: string } {
    const td = tmpDir(`sat_pvc_orphan_${tag}_`);
    const cache = path.join(td, "cache");
    const arc = path.join(td, "a.7z");
    fs.mkdirSync(cache);
    fs.writeFileSync(arc, "archive bytes");
    initPreviewCache(cache, () => ({ maxFiles: 100, maxBytes: 1024 * 1024, ttlMs: 1000 * 1000 }));
    return { td, cache, arc };
  }

  it("reclaims an entry as soon as the source archive is deleted", async () => {
    const { td, cache, arc } = setup("deleted");
    try {
      const st = fs.statSync(arc);
      const f = path.join(cache, "del.bin");
      await storePreviewCache(f, Buffer.from("content"), {
        archivePath: arc,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
      fs.rmSync(arc); // user deletes the archive
      expect(sweepPreviewCache(cache)).toBe(1);
      expect(fs.existsSync(f)).toBe(false);
      expect(fs.existsSync(path.join(cache, "index.json"))).toBe(false); // empty index removed
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });

  it("reclaims an entry when the archive is modified (stat mismatch)", async () => {
    const { td, cache, arc } = setup("modified");
    try {
      const st = fs.statSync(arc);
      const f = path.join(cache, "mod.bin");
      await storePreviewCache(f, Buffer.from("content"), {
        archivePath: arc,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
      fs.writeFileSync(arc, "changed bytes"); // mtime+size change
      expect(sweepPreviewCache(cache)).toBe(1);
      expect(fs.existsSync(f)).toBe(false);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });

  it("keeps an entry whose archive is unchanged", async () => {
    const { td, cache, arc } = setup("alive");
    try {
      const st = fs.statSync(arc);
      const f = path.join(cache, "keep.bin");
      await storePreviewCache(f, Buffer.from("content"), {
        archivePath: arc,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
      expect(sweepPreviewCache(cache)).toBe(0);
      expect(fs.existsSync(f)).toBe(true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });

  it("entries without an origin record are kept (index loss degrades to TTL)", async () => {
    const { td, cache, arc } = setup("noindex");
    try {
      const f = path.join(cache, "plain.bin");
      await storePreviewCache(f, Buffer.from("content")); // no origin passed
      fs.rmSync(arc); // archive gone, but we have no record of it
      expect(sweepPreviewCache(cache)).toBe(0);
      expect(fs.existsSync(f)).toBe(true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });

  it("a corrupt origins index does not cause mass deletion", async () => {
    const { td, cache, arc } = setup("corrupt");
    try {
      const st = fs.statSync(arc);
      const f = path.join(cache, "corr.bin");
      await storePreviewCache(f, Buffer.from("content"), {
        archivePath: arc,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
      fs.rmSync(arc); // orphan, but…
      fs.writeFileSync(path.join(cache, "index.json"), "{ not json !!!");
      expect(sweepPreviewCache(cache)).toBe(0); // …unreadable index → TTL fallback
      expect(fs.existsSync(f)).toBe(true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });

  it("a lost index (crash between file write and index write) keeps the file for the TTL", async () => {
    const { td, cache, arc } = setup("lostindex");
    try {
      const st = fs.statSync(arc);
      const f = path.join(cache, "lost.bin");
      await storePreviewCache(f, Buffer.from("content"), {
        archivePath: arc,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
      fs.rmSync(path.join(cache, "index.json")); // simulate the crash window
      fs.rmSync(arc); // archive deleted in the meantime
      // Without the index there is no orphan knowledge — the file must
      // survive for the TTL, not be mass-deleted.
      expect(sweepPreviewCache(cache)).toBe(0);
      expect(fs.existsSync(f)).toBe(true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });

  it("dead index references (crash between file unlink and index rewrite) self-heal", async () => {
    const { td, cache, arc } = setup("deadref");
    try {
      const st = fs.statSync(arc);
      const f = path.join(cache, "dead.bin");
      await storePreviewCache(f, Buffer.from("content"), {
        archivePath: arc,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
      secureUnlink(f); // simulate: file swept, index rewrite interrupted
      expect(sweepPreviewCache(cache)).toBe(0); // nothing to reclaim (file gone)
      // The stale reference is pruned; an emptied index is removed
      // entirely (writeIndex deletes empty indexes).
      const indexPath = path.join(cache, "index.json");
      if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        expect(index.entries["dead.bin"]).toBeUndefined();
      }
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });

  it("deduped copies are reclaimed independently per origin", async () => {
    const td = tmpDir("sat_pvc_orphan_dedup_");
    const cache = path.join(td, "cache");
    const arcA = path.join(td, "a.7z");
    const arcB = path.join(td, "b.7z");
    fs.mkdirSync(cache);
    fs.writeFileSync(arcA, "archive A");
    fs.writeFileSync(arcB, "archive B");
    initPreviewCache(cache, () => ({ maxFiles: 100, maxBytes: 1024 * 1024, ttlMs: 1000 * 1000 }));
    try {
      const fA = path.join(cache, "da.bin");
      const fB = path.join(cache, "db.bin");
      const data = Buffer.from("identical bytes");
      await storePreviewCache(fA, data, {
        archivePath: arcA,
        mtimeMs: fs.statSync(arcA).mtimeMs,
        size: fs.statSync(arcA).size,
      });
      await storePreviewCache(fB, data, {
        archivePath: arcB,
        mtimeMs: fs.statSync(arcB).mtimeMs,
        size: fs.statSync(arcB).size,
      });
      expect(fs.statSync(fA).ino).toBe(fs.statSync(fB).ino); // hardlinked

      fs.rmSync(arcA); // only A's archive is deleted
      expect(sweepPreviewCache(cache)).toBe(1);
      expect(fs.existsSync(fA)).toBe(false);
      expect(fs.existsSync(fB)).toBe(true); // B survives
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });
});

describe("clearPreviewCache", () => {
  it("removes every cached file and the dedup manifest", async () => {
    const a = path.join(dir, "clear_a.bin");
    await storePreviewCache(a, Buffer.from("to be cleared"));
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(path.join(dir, "index.json"))).toBe(true);
    const removed = clearPreviewCache();
    expect(removed).toBeGreaterThanOrEqual(2); // file + index
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(path.join(dir, "index.json"))).toBe(false);
  });

  it("clears the origins index too", async () => {
    const td = tmpDir("sat_pvc_orphan_clear_");
    const cacheDir2 = path.join(td, "cache");
    const arc2 = path.join(td, "a.7z");
    fs.mkdirSync(cacheDir2);
    fs.writeFileSync(arc2, "archive bytes");
    initPreviewCache(cacheDir2, () => ({ maxFiles: 100, maxBytes: 1024 * 1024, ttlMs: 1000 * 1000 }));
    try {
      const st = fs.statSync(arc2);
      const f = path.join(cacheDir2, "clear2.bin");
      await storePreviewCache(f, Buffer.from("content"), {
        archivePath: arc2,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
      expect(fs.existsSync(path.join(cacheDir2, "index.json"))).toBe(true);
      clearPreviewCache();
      expect(fs.existsSync(f)).toBe(false);
      expect(fs.existsSync(path.join(cacheDir2, "index.json"))).toBe(false);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
      initPreviewCache(dir);
    }
  });
});

function sha256hex(data: Buffer): string {
  return require("crypto").createHash("sha256").update(data).digest("hex");
}
