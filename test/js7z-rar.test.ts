/**
 * Feasibility: can the WASM 7-Zip (js7z) decompress RAR5 archives?
 * Gate for the pure-WASM package — RAR extraction has no native 7zz
 * there, so js7z is the only option.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { decompressWith7z } from "../src/engines/js7z-decompress-core";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

// Fixture creation needs a real RAR5 engine (native binding or WASI
// fallback); skipped in the bare `check` CI job where neither is staged.
const HAS_RAR5_ENGINE = gate("rar5Binding") || gate("rar5Wasm");

const FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

async function roundtrip(archive: string, password: string | undefined, out: string) {
  await decompressWith7z({ inputPath: archive, outputDir: out, password });
}

describe.runIf(HAS_RAR5_ENGINE)("js7z RAR5 decompression (pure-WASM package gate)", () => {
  it("decompresses a plain RAR5 archive", async () => {
    const dir = tmpDir("sat_jrar-");
    try {
      const proj = path.join(dir, "proj");
      fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
      fs.writeFileSync(path.join(proj, "a.txt"), "alpha data");
      fs.writeFileSync(path.join(proj, "sub", "b.txt"), "beta data");
      const archive = path.join(dir, "plain.rar");
      await compressWithRar5(
        { format: FORMAT, outputPath: archive, targets: [{ fsPath: proj }], level: 3 },
        undefined,
        undefined,
        [],
      );
      const out = path.join(dir, "out");
      await roundtrip(archive, undefined, out);
      expect(fs.readFileSync(path.join(out, "proj", "a.txt"), "utf8")).toBe("alpha data");
      expect(fs.readFileSync(path.join(out, "proj", "sub", "b.txt"), "utf8")).toBe("beta data");
      console.log("[js7z-rar] plain RAR5 decompress OK");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decompresses a password-protected RAR5 archive", async () => {
    const dir = tmpDir("sat_jrarpw-");
    try {
      const proj = path.join(dir, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "secret.txt"), crypto.randomBytes(4096).toString("hex"));
      const archive = path.join(dir, "enc.rar");
      await compressWithRar5(
        {
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: proj }],
          password: "pw123",
          level: 3,
        },
        undefined,
        undefined,
        [],
      );
      const out = path.join(dir, "out");
      await roundtrip(archive, "pw123", out);
      const original = fs.readFileSync(path.join(proj, "secret.txt"), "utf8");
      const extracted = fs.readFileSync(path.join(out, "proj", "secret.txt"), "utf8");
      expect(extracted).toBe(original);
      console.log("[js7z-rar] password-protected RAR5 decompress OK");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decompresses a header-encrypted RAR5 archive", async () => {
    const dir = tmpDir("sat_jrarrhdr-");
    try {
      const proj = path.join(dir, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "hidden.txt"), "hidden name");
      const archive = path.join(dir, "hdr.rar");
      await compressWithRar5(
        {
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: proj }],
          password: "pw123",
          encryptHeaders: true,
          level: 3,
        },
        undefined,
        undefined,
        [],
      );
      // names hidden without password — js7z must still extract WITH it
      const out = path.join(dir, "out");
      await roundtrip(archive, "pw123", out);
      expect(fs.readFileSync(path.join(out, "proj", "hidden.txt"), "utf8")).toBe("hidden name");
      console.log("[js7z-rar] header-encrypted RAR5 decompress OK");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
