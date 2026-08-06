/**
 * RAR-capability detection for system 7-Zip — Smart Archive
 *
 * Some distro builds of 7-Zip ship without RAR support (e.g. Fedora's
 * 7zip package), which made every RAR operation fail with "Cannot open
 * the file as archive". `hasRarSupport` probes `7z i` so RAR work is
 * always routed to a RAR-capable binary (the bundled full-format 7zz).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasRarSupport, system7zForExt } from "../src/engines/system7z";

function fake7z(dir: string, name: string, rar: boolean): string {
  const p = path.join(dir, name);
  const formats = rar
    ? ["Formats:", "  Rar5", "  Rar", "  Zip", "  7z", "  Xz"]
    : ["Formats:", "  Zip", "  7z", "  Xz"];
  fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' ${formats.map((f) => `'${f}'`).join(" ")}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

describe("hasRarSupport", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar7z-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts a 7-Zip build that lists Rar5/Rar formats", () => {
    const p = fake7z(dir, "full7z", true);
    expect(hasRarSupport(p)).toBe(true);
  });

  it("rejects a license-stripped build without RAR formats", () => {
    const p = fake7z(dir, "stripped7z", false);
    expect(hasRarSupport(p)).toBe(false);
  });
});

describe("system7zForExt (RAR)", () => {
  const bundled = path.join(
    __dirname,
    "..",
    "vendor",
    "7z-bin",
    process.platform,
    process.arch,
    process.platform === "win32" ? "7zz.exe" : "7zz",
  );

  it.runIf(fs.existsSync(bundled))(
    "routes RAR to the bundled full-format 7zz on this machine",
    () => {
      const resolved = system7zForExt(".rar");
      expect(resolved).toBeTruthy();
      expect(path.basename(resolved!)).toBe(path.basename(bundled));
      expect(hasRarSupport(resolved!)).toBe(true);
    },
  );
});
