/**
 * Volume size unit tests — Smart Archiver VSCode Extension
 *
 * Sizes are binary everywhere (m = MiB, g = GiB), so the only thing that has
 * to be normalized is a fractional size typed by the user: 7z's `-v` takes an
 * integer, and a decimal in the switch makes 7z fail outright.
 */

import { describe, it, expect } from "vitest";
import { toBinaryVolumeSize, VOLUME_SIZES } from "../src/utils/volume-sizes";

describe("toBinaryVolumeSize", () => {
  it("passes integer k sizes through unchanged", () => {
    expect(toBinaryVolumeSize("1440k")).toBe("1440k");
    expect(toBinaryVolumeSize("500k")).toBe("500k");
    expect(toBinaryVolumeSize("1k")).toBe("1k");
  });

  it("leaves integer m/g sizes literal — m is MiB, g is GiB", () => {
    expect(toBinaryVolumeSize("650m")).toBe("650m");
    expect(toBinaryVolumeSize("100m")).toBe("100m");
    expect(toBinaryVolumeSize("700m")).toBe("700m");
    expect(toBinaryVolumeSize("1g")).toBe("1g");
    expect(toBinaryVolumeSize("2g")).toBe("2g");
  });

  it("converts a fractional size to exact integer bytes (7z -v takes integers only)", () => {
    // A typed "1.1m" used to pass through unchanged → `-v1.1m` → 7z rejects
    // the command and writes nothing at all.
    expect(toBinaryVolumeSize("1.1m")).toBe("1153433b"); // 1.1 * 1048576 = 1153433.6
    expect(toBinaryVolumeSize("1.5m")).toBe("1572864b");
    expect(toBinaryVolumeSize("4.7g")).toBe("5046586572b");
    expect(toBinaryVolumeSize("0.5k")).toBe("512b");
    // Every result stays an integer + suffix, the only shape -v accepts.
    for (const v of ["1.1m", "1.5m", "4.7g", "0.5k", "100m", "1g"]) {
      expect(toBinaryVolumeSize(v)).toMatch(/^\d+(?:k|m|g|b)$/);
    }
  });

  it("preserves the input for integer sizes, including case", () => {
    expect(toBinaryVolumeSize("650M")).toBe("650M");
    expect(toBinaryVolumeSize("1G")).toBe("1G");
    expect(toBinaryVolumeSize("1440K")).toBe("1440K");
  });

  it("passes large integer sizes through", () => {
    expect(toBinaryVolumeSize("999g")).toBe("999g");
  });

  it("returns original value for invalid formats", () => {
    expect(toBinaryVolumeSize("")).toBe("");
    expect(toBinaryVolumeSize("abc")).toBe("abc");
    expect(toBinaryVolumeSize("100x")).toBe("100x");
    expect(toBinaryVolumeSize("100")).toBe("100"); // missing unit
    expect(toBinaryVolumeSize("1.1")).toBe("1.1"); // missing unit
  });

  it("handles zero values", () => {
    expect(toBinaryVolumeSize("0m")).toBe("0m");
    expect(toBinaryVolumeSize("0g")).toBe("0g");
    expect(toBinaryVolumeSize("0.0m")).toBe("0.0m");
  });
});

describe("volume size presets", () => {
  it("is a short built-in ladder, and the setting default stays empty", async () => {
    const pkg = (await import("../package.json")) as unknown as {
      default: {
        contributes: {
          configuration: {
            properties: Record<string, { default: Record<string, string> }>;
          };
        };
      };
    };
    const def =
      pkg.default.contributes.configuration.properties["smart-archiver.volumes.sizes"].default;
    // A non-empty object default is merged with the user's keys in the settings
    // editor, so the list would show the built-ins *and* the user's sizes.
    expect(def).toEqual({});
    // The picker always takes a typed size; the ladder only saves typing.
    expect(VOLUME_SIZES.map((v) => v.label)).toEqual(["100M", "700M", "1G", "2G", "4700M"]);
    for (const preset of VOLUME_SIZES) {
      expect(preset.value).toMatch(/^\d+[kmg]$/i);
      // No label-to-value mapping to explain: the label *is* the value.
      expect(preset.label.toUpperCase()).toBe(preset.value.toUpperCase());
    }
  });

  it("uses the built-in ladder when the setting is empty, and only your map when it is not", async () => {
    const { getVolumeSizes } = await import("../src/utils/volume-sizes");
    const { __setConfig } = (await import("./__mocks__/vscode")) as {
      __setConfig: (section: string, key: string, value: unknown) => void;
    };
    expect(getVolumeSizes().map((s) => s.label)).toEqual(VOLUME_SIZES.map((v) => v.label));
    __setConfig("smart-archiver", "volumes.sizes", { "650M": "650m" });
    // Replaced, not appended: no built-in sneaks in after the user's own sizes.
    expect(getVolumeSizes().map((s) => s.label)).toEqual(["650M"]);
  });
});
