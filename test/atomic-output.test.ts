/**
 * withAtomicOutput tests — Smart Archive VSCode Extension
 *
 * Locks the atomic-write contract for conversion/merge: the destination is
 * only ever touched via a same-directory temp file renamed into place on
 * success, so a failed or cancelled write can never corrupt an existing
 * archive (the merge-over-self scenario) and never leaves temp leftovers.
 *
 * @module test/atomic-output
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { withAtomicOutput, renameOverwrite } from "../src/utils/fs";
import { tmpDir } from "./tmp";

describe("withAtomicOutput (single file)", () => {
  it("renames the temp output onto dstPath on success", async () => {
    const dir = tmpDir("saao-");
    const dst = path.join(dir, "out.7z");
    await withAtomicOutput({
      dstPath: dst,
      write: async (outPath) => {
        fs.writeFileSync(outPath, "payload");
      },
    });
    expect(fs.readFileSync(dst, "utf8")).toBe("payload");
    // No temp leftovers.
    expect(fs.readdirSync(dir)).toEqual(["out.7z"]);
  });

  it("overwrites an existing dstPath atomically on success (merge-over-self)", async () => {
    const dir = tmpDir("saao-");
    const dst = path.join(dir, "out.rar");
    fs.writeFileSync(dst, "old-archive");
    await withAtomicOutput({
      dstPath: dst,
      write: async (outPath) => {
        fs.writeFileSync(outPath, "new-archive");
      },
    });
    expect(fs.readFileSync(dst, "utf8")).toBe("new-archive");
  });

  it("leaves dstPath untouched and cleans the temp file on failure", async () => {
    const dir = tmpDir("saao-");
    const dst = path.join(dir, "out.7z");
    fs.writeFileSync(dst, "precious");
    await expect(
      withAtomicOutput({
        dstPath: dst,
        write: async (outPath) => {
          fs.writeFileSync(outPath, "partial");
          throw new Error("compression failed mid-way");
        },
      }),
    ).rejects.toThrow(/compression failed/);
    // The original archive is intact and nothing temp remains.
    expect(fs.readFileSync(dst, "utf8")).toBe("precious");
    expect(fs.readdirSync(dir)).toEqual(["out.7z"]);
  });

  it("cleans partial volume leftovers on failure", async () => {
    const dir = tmpDir("saao-");
    const dst = path.join(dir, "out.7z");
    await expect(
      withAtomicOutput({
        dstPath: dst,
        volumeSize: "1m",
        write: async (outPath) => {
          fs.writeFileSync(outPath + ".001", "vol1");
          fs.writeFileSync(outPath + ".002", "vol2");
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow(/cancelled/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("withAtomicOutput (volume set)", () => {
  it("moves tmpOut.001..N onto dstPath.001..N", async () => {
    const dir = tmpDir("saao-");
    const dst = path.join(dir, "out.7z");
    await withAtomicOutput({
      dstPath: dst,
      volumeSize: "1m",
      write: async (outPath) => {
        fs.writeFileSync(outPath + ".001", "vol1");
        fs.writeFileSync(outPath + ".002", "vol2");
        fs.writeFileSync(outPath + ".003", "vol3");
      },
    });
    expect(fs.readFileSync(dst + ".001", "utf8")).toBe("vol1");
    expect(fs.readFileSync(dst + ".002", "utf8")).toBe("vol2");
    expect(fs.readFileSync(dst + ".003", "utf8")).toBe("vol3");
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith(".sa_tmp_"));
    expect(leftovers).toEqual([]);
  });

  it("falls back to a single-file rename when the engine did not split", async () => {
    const dir = tmpDir("saao-");
    const dst = path.join(dir, "out.7z");
    await withAtomicOutput({
      dstPath: dst,
      volumeSize: "1m",
      write: async (outPath) => {
        fs.writeFileSync(outPath, "tiny-output");
      },
    });
    expect(fs.readFileSync(dst, "utf8")).toBe("tiny-output");
  });
});

describe("renameOverwrite", () => {
  it("replaces an existing destination", () => {
    const dir = tmpDir("saao-");
    const src = path.join(dir, "src");
    const dst = path.join(dir, "dst");
    fs.writeFileSync(src, "new");
    fs.writeFileSync(dst, "old");
    renameOverwrite(src, dst);
    expect(fs.readFileSync(dst, "utf8")).toBe("new");
    expect(fs.existsSync(src)).toBe(false);
  });
});
