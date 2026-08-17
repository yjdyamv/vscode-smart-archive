/**
 * Cache lifecycle policy tests — Smart Archiver VSCode Extension
 *
 * The caches must not outlive the extension: update, disable, and
 * uninstall should clear them, while a plain window close must keep them
 * (persistence is their point). The policy lives in extension.ts —
 * cacheVersionChanged (update detection) and the constants it uses.
 */

import { describe, it, expect } from "vitest";
import { cacheVersionChanged } from "../src/extension";
import { CACHE_VERSION_KEY } from "../src/constants";

describe("cacheVersionChanged", () => {
  it("first install keeps whatever exists (nothing was ours)", () => {
    expect(cacheVersionChanged(undefined, "1.28.1")).toBe(false);
  });

  it("same version keeps the caches (re-enable, same-version reinstall)", () => {
    expect(cacheVersionChanged("1.28.1", "1.28.1")).toBe(false);
  });

  it("a version change invalidates the caches", () => {
    expect(cacheVersionChanged("1.28.1", "1.29.0")).toBe(true);
  });

  it("downgrade also invalidates (fresh install over an older copy)", () => {
    expect(cacheVersionChanged("1.29.0", "1.28.1")).toBe(true);
  });

  it("an unknown current version (test host) still clears a known previous", () => {
    expect(cacheVersionChanged("1.28.1", undefined)).toBe(true);
  });
});

describe("cache lifecycle constants", () => {
  it("records the version under a stable globalState key", () => {
    expect(CACHE_VERSION_KEY).toBe("smartArchiveCacheVersion");
  });
});
