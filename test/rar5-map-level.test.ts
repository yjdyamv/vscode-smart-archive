/**
 * rar5 level mapping tests — Smart Archiver VSCode Extension
 *
 * Locks the "store" fix: 7z level 0 (store only) must map to rar5 level 0,
 * not to the old `level || 5` fallback that silently produced level 3
 * compression. Undefined (unset) still means the default level.
 *
 * @module test/rar5-map-level
 */

import { describe, it, expect } from "vitest";
import { mapLevel } from "../src/engines/rar5-engine";

describe("mapLevel", () => {
  it("maps 7z store (0) to rar5 store (0)", () => {
    expect(mapLevel(0)).toBe(0);
  });

  it("maps the unset level like the 7z default (5) — i.e. rar5 3", () => {
    // undefined means "use the default", and the default 5 maps to 3 —
    // identical to the pre-fix behavior; the fix only touched level 0.
    expect(mapLevel(undefined)).toBe(3);
    expect(mapLevel(undefined)).toBe(mapLevel(5));
  });

  it("stays within the rar5 range 0..=5 across the 7z range 0..=9", () => {
    for (let l = 0; l <= 9; l++) {
      const mapped = mapLevel(l);
      expect(mapped, `level ${l}`).toBeGreaterThanOrEqual(0);
      expect(mapped, `level ${l}`).toBeLessThanOrEqual(5);
    }
  });

  it("maps the 7z default (5) onto the rar5 middle (3)", () => {
    expect(mapLevel(5)).toBe(3);
  });

  it("maps the 7z maximum (9) onto the rar5 maximum (5)", () => {
    expect(mapLevel(9)).toBe(5);
  });
});
