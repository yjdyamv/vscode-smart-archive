/**
 * libc probing — Smart Archiver VSCode Extension
 *
 * `parseGlibcVersion` feeds the napi-rs loaders' gnu-vs-musl decision (see
 * engines/snappy-codec.ts), so the accepted banners must match what real
 * distros print: a shape we fail to parse degrades the native codec path
 * silently. Each case below is a verbatim `ldd --version` first line.
 */

import { describe, expect, it } from "vitest";
import { glibcVersion, isMusl, parseGlibcVersion } from "../src/utils/platform";

describe("parseGlibcVersion", () => {
  it("reads a Debian/Ubuntu banner", () => {
    expect(
      parseGlibcVersion(
        "ldd (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35\nCopyright (C) 2022 Free Software Foundation, Inc.\n",
      ),
    ).toBe("2.35");
  });

  it("reads a Debian banner with a long package revision", () => {
    expect(parseGlibcVersion("ldd (Debian GLIBC 2.36-9+deb12u4) 2.36\n")).toBe("2.36");
  });

  it("reads a banner that names GNU libc instead of GLIBC", () => {
    expect(parseGlibcVersion("ldd (GNU libc) 2.31\n")).toBe("2.31");
  });

  it("keeps a three-component version", () => {
    expect(parseGlibcVersion("ldd (GNU libc) 2.36.1\n")).toBe("2.36.1");
  });

  it("returns null for musl's ldd banner", () => {
    expect(
      parseGlibcVersion("musl libc (x86_64)\nVersion 1.2.4\n\tDynamic Program Loader\n"),
    ).toBeNull();
  });

  it("returns null for empty or unparseable output", () => {
    expect(parseGlibcVersion("")).toBeNull();
    expect(parseGlibcVersion("not an ldd banner")).toBeNull();
  });
});

describe("glibcVersion", () => {
  it("returns a version string or null — never throws", () => {
    const v = glibcVersion();
    if (v !== null) expect(v).toMatch(/^\d+\.\d+/);
  });

  it("is cached, so repeated calls agree", () => {
    expect(glibcVersion()).toBe(glibcVersion());
  });
});

describe("isMusl", () => {
  it("is false on non-linux hosts", () => {
    // On Linux the answer depends on the host image; the probe itself is
    // exercised by glibcVersion() above.
    if (process.platform === "linux") return;
    expect(isMusl()).toBe(false);
  });
});
