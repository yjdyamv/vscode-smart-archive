/**
 * Volume size unit tests — Smart Archive VSCode Extension
 *
 * Tests for toBinaryVolumeSize (decimal-to-binary unit conversion)
 * and VOLUME_SIZES presets.
 */

import { describe, it, expect } from "vitest";
import { toBinaryVolumeSize, VOLUME_SIZES } from "../src/utils/volume-sizes";

describe("toBinaryVolumeSize", () => {
  it("passes through k values unchanged (1 KB = 1024 B in both systems)", () => {
    expect(toBinaryVolumeSize("1440k")).toBe("1440k");
    expect(toBinaryVolumeSize("500k")).toBe("500k");
    expect(toBinaryVolumeSize("1k")).toBe("1k");
  });

  it("converts decimal MB to binary MiB", () => {
    // 650 * 1,000,000 / 1,048,576 = 619.9... → floor 619
    expect(toBinaryVolumeSize("650m")).toBe("619m");
    // 100 * 1,000,000 / 1,048,576 = 95.3... → floor 95
    expect(toBinaryVolumeSize("100m")).toBe("95m");
    // 700 * 1,000,000 / 1,048,576 = 667.5... → floor 667
    expect(toBinaryVolumeSize("700m")).toBe("667m");
  });

  it("converts decimal GB to binary MiB", () => {
    // 1 * 1,000,000,000 / 1,048,576 = 953.6... → floor 953
    expect(toBinaryVolumeSize("1g")).toBe("953m");
    // 2 * 1,000,000,000 / 1,048,576 = 1907.3... → floor 1907
    expect(toBinaryVolumeSize("2g")).toBe("1907m");
  });

  it("returns original value for invalid formats", () => {
    expect(toBinaryVolumeSize("")).toBe("");
    expect(toBinaryVolumeSize("abc")).toBe("abc");
    expect(toBinaryVolumeSize("100x")).toBe("100x");
    expect(toBinaryVolumeSize("100")).toBe("100"); // missing unit
  });

  it("handles zero values", () => {
    expect(toBinaryVolumeSize("0m")).toBe("0m");
    // 0g → 0 MiB, but binaryMib > 0 check fails → returns original
    expect(toBinaryVolumeSize("0g")).toBe("0g");
  });

  it("preserves case of input", () => {
    expect(toBinaryVolumeSize("650M")).toBe("619m");
    expect(toBinaryVolumeSize("1G")).toBe("953m");
    // k values are returned unchanged (case preserved)
    expect(toBinaryVolumeSize("1440K")).toBe("1440K");
  });

  it("handles large values without overflow", () => {
    // 999g = 999 * 1B = 999,000,000,000 / 1,048,576 ≈ 952,720 MiB
    const result = toBinaryVolumeSize("999g");
    expect(result).toMatch(/^\d+m$/);
    const mib = parseInt(result, 10);
    expect(mib).toBeGreaterThan(950_000);
    expect(mib).toBeLessThan(1_000_000);
  });

  it("4700m is treated as decimal MB and converted", () => {
    // This is the 4.7G preset: "4700m"
    // 4700 * 1,000,000 / 1,048,576 ≈ 4482 MiB
    const result = toBinaryVolumeSize("4700m");
    expect(result).toMatch(/^\d+m$/);
    const mib = parseInt(result, 10);
    expect(mib).toBeLessThan(4700); // should shrink when converting decimal→binary
  });
});

describe("VOLUME_SIZES", () => {
  it("contains all expected preset labels", () => {
    const labels = VOLUME_SIZES.map((v) => v.label);
    expect(labels).toEqual([
      "1.44M", "10M", "25M", "50M", "100M", "200M",
      "650M", "700M", "1G", "2G", "4.7G",
    ]);
  });

  it("each preset has a valid volume-size value", () => {
    for (const preset of VOLUME_SIZES) {
      expect(preset.value).toMatch(/^\d+[kmg]$/i);
    }
  });

  it("4.7G preset maps to 4700m", () => {
    const dvd = VOLUME_SIZES.find((v) => v.label === "4.7G");
    expect(dvd).toBeDefined();
    expect(dvd!.value).toBe("4700m");
  });

  it("1.44M preset maps to 1440k", () => {
    const floppy = VOLUME_SIZES.find((v) => v.label === "1.44M");
    expect(floppy).toBeDefined();
    expect(floppy!.value).toBe("1440k");
  });
});
