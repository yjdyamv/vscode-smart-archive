/**
 * resolveCompressFormats — Smart Archiver
 *
 * The compress-picker whitelist/order setting (`default.formatOrder`):
 *   - empty/undefined order falls back to the default table order
 *   - whitelist order is preserved, non-listed formats are hidden
 *   - unknown labels are ignored
 *   - the configured default format is always included and pinned on top
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { COMPRESS_FORMATS, resolveCompressFormats } from "../src/constants";

const labels = (formats: { label: string }[]): string[] => formats.map((f) => f.label);

describe("resolveCompressFormats", () => {
  it("falls back to the default list when order is empty or undefined", () => {
    expect(labels(resolveCompressFormats(undefined, "7z"))).toEqual(labels(COMPRESS_FORMATS));
    expect(labels(resolveCompressFormats([], "7z"))).toEqual(labels(COMPRESS_FORMATS));
  });

  it("keeps the whitelist order and hides non-listed formats", () => {
    expect(labels(resolveCompressFormats(["zip", "tar.gz", "7z"], "7z"))).toEqual([
      "7z",
      "zip",
      "tar.gz",
    ]);
    expect(labels(resolveCompressFormats(["rar", "wim"], "7z"))).toEqual(["7z", "rar", "wim"]);
  });

  it("ignores unknown labels", () => {
    expect(labels(resolveCompressFormats(["zip", "nope", "7z", ""], "7z"))).toEqual([
      "7z",
      "zip",
    ]);
  });

  it("pins the default format on top even when not whitelisted", () => {
    expect(labels(resolveCompressFormats(["zip", "tar"], "7z"))).toEqual(["7z", "zip", "tar"]);
  });

  it("does not duplicate the default format when it is whitelisted", () => {
    expect(labels(resolveCompressFormats(["zip", "7z"], "7z"))).toEqual(["7z", "zip"]);
  });

  it("does not pin a non-creatable default format", () => {
    expect(labels(resolveCompressFormats(["zip"], "iso"))).toEqual(["zip"]);
  });

  it("returns an empty list when the whitelist has no valid entries", () => {
    expect(resolveCompressFormats(["nope"], "iso")).toEqual([]);
  });

  it("the package.json enum lists exactly the creatable formats", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ) as {
      contributes: {
        configuration: {
          properties: {
            "smart-archiver.default.formatOrder": { items: { enum: string[] } };
          };
        };
      };
    };
    const enumLabels = pkg.contributes.configuration.properties[
      "smart-archiver.default.formatOrder"
    ].items.enum;
    expect(enumLabels).toEqual(labels(COMPRESS_FORMATS));
  });
});
