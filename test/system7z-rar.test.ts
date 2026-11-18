/**
 * RAR-capability detection for system 7-Zip — Smart Archiver
 *
 * Some distro builds of 7-Zip ship without RAR support (e.g. Fedora's
 * 7zip package), which made every RAR operation fail with "Cannot open
 * the file as archive". `hasRarSupport` probes `7z i` so RAR work is
 * always routed to a RAR-capable binary (the bundled full-format 7zz).
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasRarSupport,
  outputHasRarSupport,
  rarProbeVerdict,
  system7zForExt,
} from "../src/engines/system7z";
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

describe("rarProbeVerdict", () => {
  it("treats a binary that answered as definitive", () => {
    expect(rarProbeVerdict(0, "Formats:\n  Rar5\n  Rar\n  Zip")).toBe("supported");
    expect(rarProbeVerdict(0, "Formats:\n  Zip\n  7z\n  Xz")).toBe("unsupported");
  });

  it("treats a timeout or spawn failure as inconclusive", () => {
    // spawnSync reports a timeout as signal-killed with a null status.
    expect(rarProbeVerdict(null, "Formats:\n  Rar5")).toBe("unknown");
    expect(rarProbeVerdict(1, "Formats:\n  Rar5")).toBe("unknown");
    expect(rarProbeVerdict(null, "")).toBe("unknown");
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

/**
 * A fake that records every invocation, then either answers (exit 0, with or
 * without RAR in the list) or bails out without an answer (exit 1).
 */
function fake7zCounting(
  dir: string,
  name: string,
  opts: { rar: boolean; exit: number },
): { bin: string; runs: () => number } {
  const bin = path.join(dir, name);
  const counter = path.join(dir, `${name}.runs`);
  const formats = opts.rar
    ? ["Formats:", "  Rar5", "  Rar", "  Zip"]
    : ["Formats:", "  Zip", "  7z"];
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho x >> "${counter}"\nprintf '%s\\n' ${formats.map((f) => `'${f}'`).join(" ")}\nexit ${opts.exit}\n`,
  );
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    runs: () =>
      fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim().split("\n").length : 0,
  };
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

  it.runIf(process.platform !== "win32")("caches a definitive answer (the probe runs once)", () => {
    const fake = fake7zCounting(dir, "cached7z", { rar: true, exit: 0 });
    expect(hasRarSupport(fake.bin)).toBe(true);
    expect(hasRarSupport(fake.bin)).toBe(true);
    expect(fake.runs()).toBe(1);
  });

  it.runIf(process.platform !== "win32")(
    "re-probes after an inconclusive run instead of caching 'no RAR'",
    () => {
      // A cold-start timeout must not demote RAR to WASM for the session.
      const fake = fake7zCounting(dir, "timeout7z", { rar: true, exit: 1 });
      expect(hasRarSupport(fake.bin)).toBe(false);
      expect(hasRarSupport(fake.bin)).toBe(false);
      expect(fake.runs()).toBe(2);
    },
  );
});

describe("system7zForExt (RAR)", () => {
  const bundled = bundled7zPath();

  it.runIf(gate("bundled7zz"))("routes RAR to the bundled full-format 7zz on this machine", () => {
    const resolved = system7zForExt(".rar");
    expect(resolved).toBeTruthy();
    expect(path.basename(resolved!)).toBe(path.basename(bundled));
    expect(hasRarSupport(resolved!)).toBe(true);
  });
});
