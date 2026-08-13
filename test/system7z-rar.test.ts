/**
 * RAR-capability detection for system 7-Zip — Smart Archive
 *
 * Some distro builds of 7-Zip ship without RAR support (e.g. Fedora's
 * 7zip package), which made every RAR operation fail with "Cannot open
 * the file as archive". `hasRarSupport` probes `7z i` so RAR work is
 * always routed to a RAR-capable binary (the bundled full-format 7zz).
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasRarSupport, outputHasRarSupport, system7zForExt } from "../src/engines/system7z";
import { bundled7zPath } from "../src/engines/bundled7z";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

// The `7z i` output parser is platform-independent — this is the coverage
// that runs everywhere (including Windows, where the shell-script fakes
// below cannot execute).
describe("outputHasRarSupport", () => {
  it("accepts output listing Rar5/Rar formats", () => {
    expect(outputHasRarSupport("Formats:\n  Rar5\n  Rar\n  Zip\n  7z\n  Xz")).toBe(true);
    expect(outputHasRarSupport("  Rar5")).toBe(true);
    expect(outputHasRarSupport("  Rar")).toBe(true);
  });

  it("rejects output without RAR formats", () => {
    expect(outputHasRarSupport("Formats:\n  Zip\n  7z\n  Xz")).toBe(false);
    expect(outputHasRarSupport("")).toBe(false);
  });
});

// The spawn integration path needs an executable fake; POSIX shell scripts
// cannot run on Windows, so the fakes are POSIX-only (the parser above
// still covers the logic everywhere).
function fake7z(dir: string, name: string, rar: boolean): string {
  const p = path.join(dir, name);
  const formats = rar
    ? ["Formats:", "  Rar5", "  Rar", "  Zip", "  7z", "  Xz"]
    : ["Formats:", "  Zip", "  7z", "  Xz"];
  fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' ${formats.map((f) => `'${f}'`).join(" ")}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

describe("hasRarSupport (POSIX spawn integration)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("sat_rar7z-");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.runIf(process.platform !== "win32")(
    "accepts a 7-Zip build that lists Rar5/Rar formats",
    () => {
      const p = fake7z(dir, "full7z", true);
      expect(hasRarSupport(p)).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a license-stripped build without RAR formats",
    () => {
      const p = fake7z(dir, "stripped7z", false);
      expect(hasRarSupport(p)).toBe(false);
    },
  );
});

describe("system7zForExt (RAR)", () => {
  const bundled = bundled7zPath();

  it.runIf(gate("bundled7zz"))(
    "routes RAR to the bundled full-format 7zz on this machine",
    () => {
      const resolved = system7zForExt(".rar");
      expect(resolved).toBeTruthy();
      expect(path.basename(resolved!)).toBe(path.basename(bundled));
      expect(hasRarSupport(resolved!)).toBe(true);
    },
  );
});
