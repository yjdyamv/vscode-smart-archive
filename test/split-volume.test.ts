import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";

import { getSplitVolumeStem, detectVolumeSize, getSplitOutputPath } from "../src/providers/webview/router";
import { mergeOutputPath } from "../src/providers/webview/handlers/shared";
import { tmpDir } from "./tmp";

let tdir: string;

beforeAll(() => {
  tdir = tmpDir("svt_");
});

afterAll(() => {
  fs.rmSync(tdir, { recursive: true, force: true });
});

function touch(filePath: string, size: number): void {
  const buf = Buffer.alloc(size, 0x61);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

describe("getSplitVolumeStem", () => {
  it("strips .7z.001 suffix", () => {
    expect(getSplitVolumeStem("/dir/archive.7z.001")).toBe("/dir/archive");
  });

  it("strips .zip.002 suffix", () => {
    expect(getSplitVolumeStem("/dir/archive.zip.002")).toBe("/dir/archive");
  });

  it("strips .part1.rar suffix", () => {
    expect(getSplitVolumeStem("/dir/archive.part1.rar")).toBe("/dir/archive");
  });

  it("strips .part5.rar suffix", () => {
    expect(getSplitVolumeStem("/dir/archive.part5.rar")).toBe("/dir/archive");
  });

  it("strips .r00 suffix", () => {
    expect(getSplitVolumeStem("/dir/archive.r00")).toBe("/dir/archive");
  });

  it("strips .r01 suffix", () => {
    expect(getSplitVolumeStem("/dir/archive.r01")).toBe("/dir/archive");
  });

  it("handles paths with dots in directory names", () => {
    expect(getSplitVolumeStem("/some.dir/archive.7z.001")).toBe("/some.dir/archive");
  });

  it("handles paths with spaces", () => {
    expect(getSplitVolumeStem("/my files/archive.7z.001")).toBe("/my files/archive");
  });

  it("handles windows backslash paths", () => {
    const result = getSplitVolumeStem("C:\\data\\archive.7z.001");
    expect(result).toBe("C:\\data\\archive");
  });
});

describe("mergeOutputPath", () => {
  it("targets the base archive name for .7z.001 sets", () => {
    expect(mergeOutputPath("/dir/archive.7z.001", "7z")).toBe("/dir/archive.7z");
  });

  it("uniquifies when the base target already exists", () => {
    const existing = path.join(tdir, "merge_existing.7z");
    touch(existing, 10);
    const dst = mergeOutputPath(path.join(tdir, "merge_existing.7z.001"), "7z");
    expect(dst).toBe(path.join(tdir, "merge_existing_1.7z"));
  });

  it("targets the base archive name for .part1.rar sets", () => {
    expect(mergeOutputPath("/dir/archive.part1.rar", "rar")).toBe("/dir/archive.rar");
  });

  it("keeps the current file for .rNN sets (base file is the first volume)", () => {
    // The webview redirects archive.r00 → archive.rar, so the merge target
    // equals the file being merged — replacing the first volume is intent,
    // and it must NOT be uniquified.
    expect(mergeOutputPath("/dir/archive.rar", "rar")).toBe("/dir/archive.rar");
  });
});

describe("detectVolumeSize", () => {
  it("detects 100m preset from first volume size", () => {
    const firstVol = path.join(tdir, "detect_100m.7z.001");
    touch(firstVol, 100 * 1024 * 1024); // exactly 100m
    expect(detectVolumeSize(firstVol)).toBe("100m");
  });

  it("detects 10m preset (within 10% tolerance)", () => {
    const firstVol = path.join(tdir, "detect_10m.7z.001");
    // 7z headers may add overhead; 10m + 200k is within 10%
    touch(firstVol, 10 * 1024 * 1024 + 200 * 1024);
    expect(detectVolumeSize(firstVol)).toBe("10m");
  });

  it("detects 1g preset", () => {
    const firstVol = path.join(tdir, "detect_1g.7z.001");
    touch(firstVol, 1 * 1024 * 1024 * 1024);
    expect(detectVolumeSize(firstVol)).toBe("1g");
  });

  it("falls back to approximate size for non-standard volumes", () => {
    const firstVol = path.join(tdir, "detect_custom.7z.001");
    touch(firstVol, 55 * 1024 * 1024); // 55m — no exact preset
    const result = detectVolumeSize(firstVol);
    expect(result).toMatch(/^\d+m$/);
  });

  it("returns undefined when first volume file does not exist", () => {
    expect(detectVolumeSize(path.join(tdir, "nonexistent.7z.001"))).toBeUndefined();
  });

  it("works with zip split volumes", () => {
    const firstVol = path.join(tdir, "detect_zip.zip.001");
    touch(firstVol, 50 * 1024 * 1024); // 50m
    expect(detectVolumeSize(firstVol)).toBe("50m");
  });

  it("handles RAR .part1.rar volumes", () => {
    const firstVol = path.join(tdir, "archive.part1.rar");
    touch(firstVol, 100 * 1024 * 1024);
    expect(detectVolumeSize(firstVol)).toBe("100m");
  });

  it("handles RAR .r00 volumes", () => {
    const firstVol = path.join(tdir, "archive.r00");
    touch(firstVol, 200 * 1024 * 1024);
    expect(detectVolumeSize(firstVol)).toBe("200m");
  });

  it("detects small volumes in kilobytes", () => {
    const firstVol = path.join(tdir, "small.7z.001");
    touch(firstVol, 500 * 1024); // 500k — below 1m
    const result = detectVolumeSize(firstVol);
    expect(result).toBe("500k");
  });
});

describe("getSplitOutputPath", () => {
  it("creates _encrypted folder for encrypt", () => {
    const vol = path.join(tdir, "enc_test.7z.001");
    touch(vol, 100);
    const { dst, folder } = getSplitOutputPath(vol, "7z", "_encrypted");
    expect(folder).toBe(path.join(tdir, "enc_test_encrypted"));
    expect(dst).toBe(path.join(folder, "enc_test.7z"));
  });

  it("creates _decrypted folder for decrypt", () => {
    const vol = path.join(tdir, "dec_test.7z.001");
    touch(vol, 100);
    const { dst, folder } = getSplitOutputPath(vol, "zip", "_decrypted");
    expect(folder).toBe(path.join(tdir, "dec_test_decrypted"));
    expect(dst).toBe(path.join(folder, "dec_test.zip"));
  });

  it("appends _1 _2 etc when target folder already exists", () => {
    const vol = path.join(tdir, "dup_test.7z.001");
    touch(vol, 100);
    // Create the first output folder
    fs.mkdirSync(path.join(tdir, "dup_test_encrypted"));
    const r1 = getSplitOutputPath(vol, "7z", "_encrypted");
    expect(r1.folder).toBe(path.join(tdir, "dup_test_encrypted_1"));

    fs.mkdirSync(path.join(tdir, "dup_test_encrypted_1"));
    const r2 = getSplitOutputPath(vol, "7z", "_encrypted");
    expect(r2.folder).toBe(path.join(tdir, "dup_test_encrypted_2"));
  });

  it("works with RAR .part1.rar paths", () => {
    const vol = path.join(tdir, "rar_test.part1.rar");
    touch(vol, 100);
    const { dst, folder } = getSplitOutputPath(vol, "7z", "_decrypted");
    expect(folder).toBe(path.join(tdir, "rar_test_decrypted"));
    expect(dst).toBe(path.join(folder, "rar_test.7z"));
  });

  it("uses the resolved format extension in dst", () => {
    const vol = path.join(tdir, "fmt_test.7z.001");
    touch(vol, 100);
    const { dst } = getSplitOutputPath(vol, "zip", "_encrypted");
    expect(dst).toMatch(/\.zip$/);
  });
});
