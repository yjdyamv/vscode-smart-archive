/**
 * Latest rar5 binding API — Smart Archiver
 *
 * Exercises the newest rar-rs-napi surface through rar5-engine:
 * dictionary size / solid / BLAKE2 compression options, detailed member
 * listing and native extraction. Needs a real RAR5 engine (native binding
 * or WASI fallback), so these run where one is staged.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  compressWithRar5,
  extractWithRar5,
  listRar5Entries,
  listRar5EntriesDetailed,
} from "../src/engines/rar5-engine";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

const HAS_RAR5_ENGINE = gate("rar5Binding") || gate("rar5Wasm");

const FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

describe("rar5 latest API", () => {
  it.runIf(HAS_RAR5_ENGINE)(
    "dictSize/solid/blake2 compression options produce a valid archive",
    async () => {
      const dir = tmpDir("sat_api1-");
      try {
        const file = path.join(dir, "data.bin");
        fs.writeFileSync(file, "dictionary payload ".repeat(1000));
        const archive = path.join(dir, "dict.rar");
        await compressWithRar5({
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: file }],
          password: "",
          dictSize: "64m",
          solid: true,
          blake2: true,
          level: 3,
        });
        expect(fs.existsSync(archive)).toBe(true);
        expect(fs.readFileSync(archive).subarray(0, 8).toString("latin1")).toBe("Rar!\u001a\u0007\u0001\u0000");
        // The archive round-trips through the binding.
        const names = listRar5Entries(archive);
        expect(names).toContain("data.bin");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(HAS_RAR5_ENGINE)(
    "listRar5EntriesDetailed reports sizes and methods",
    async () => {
      const dir = tmpDir("sat_api2-");
      try {
        const file = path.join(dir, "data.bin");
        fs.writeFileSync(file, "compressible ".repeat(2000));
        const archive = path.join(dir, "detail.rar");
        await compressWithRar5({
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: file }],
          password: "",
          // 7z level 5 = normal -> mapLevel(5) = rar5 method 3 (asserted below).
          level: 5,
        });
        const entries = listRar5EntriesDetailed(archive);
        const entry = entries.find((e) => e.name === "data.bin");
        expect(entry).toBeDefined();
        expect(entry!.size).toBe(26000);
        expect(entry!.packedSize).toBeLessThan(entry!.size);
        expect(entry!.method).toBe(3);
        expect(entry!.isDir).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(HAS_RAR5_ENGINE)(
    "extractWithRar5 restores members byte-identically (incl. flat and password)",
    async () => {
      const dir = tmpDir("sat_api3-");
      try {
        const file = path.join(dir, "secret.txt");
        fs.writeFileSync(file, "encrypted payload ".repeat(500));
        const archive = path.join(dir, "enc.rar");
        await compressWithRar5({
          format: FORMAT,
          outputPath: archive,
          targets: [{ fsPath: file }],
          password: "pw",
          level: 3,
        });

        const dest = path.join(dir, "out");
        await extractWithRar5(archive, dest, "pw");
        expect(fs.readFileSync(path.join(dest, "secret.txt")).toString()).toBe(
          fs.readFileSync(file).toString(),
        );

        const flatDest = path.join(dir, "flat");
        await extractWithRar5(archive, flatDest, "pw", { flat: true });
        expect(fs.readFileSync(path.join(flatDest, "secret.txt")).toString()).toBe(
          fs.readFileSync(file).toString(),
        );

        // Wrong password is rejected.
        await expect(extractWithRar5(archive, path.join(dir, "bad"), "nope")).rejects.toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
