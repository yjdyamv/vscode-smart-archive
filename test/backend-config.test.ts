/**
 * rar5 / snappy backend selection — Smart Archive
 *
 * Both codecs can run on the native Node binding or the WASM engine.
 * `smart-archive.rar5Backend` / `smart-archive.snappyBackend` (auto /
 * native / wasm) are injected via setRar5Config / setSnappyConfig; the
 * legacy env overrides (SA_RAR5_FORCE_WASM / NAPI_RS_FORCE_WASI) still win.
 * Integration cases verify the setting alone can force the WASM engine.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveRar5Backend,
  setRar5Config,
  resetRar5BindingCache,
  compressWithRar5,
  type Rar5Backend,
} from "../src/engines/rar5-engine";
import {
  resolveSnappyBackend,
  setSnappyConfig,
  resetSnappyBindingCache,
  snappyCompress,
  snappyDecompress,
  type SnappyBackend,
} from "../src/engines/snappy-codec";

const SNAPPY_WASM = path.join(
  __dirname,
  "..",
  "node_modules",
  "snappy",
  "snappy.wasi.cjs",
);
const RAR5_WASM = path.join(
  __dirname,
  "..",
  "vendor",
  "rar5-wasm",
  "smart-archive-rar.wasi.cjs",
);

const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

afterEach(() => {
  setRar5Config({});
  setSnappyConfig({});
  resetRar5BindingCache();
  resetSnappyBindingCache();
  delete process.env.SA_RAR5_FORCE_WASM;
  delete process.env.NAPI_RS_FORCE_WASI;
});

describe("rar5 backend selection", () => {
  it("defaults to auto", () => {
    expect(resolveRar5Backend()).toBe("auto");
  });

  it("prefers SA_RAR5_FORCE_WASM=1 over the setting", () => {
    setRar5Config({ backend: "native" });
    process.env.SA_RAR5_FORCE_WASM = "1";
    expect(resolveRar5Backend()).toBe("wasm");
  });

  it("honours the injected setting", () => {
    setRar5Config({ backend: "native" });
    expect(resolveRar5Backend()).toBe("native");
    setRar5Config({ backend: "wasm" });
    expect(resolveRar5Backend()).toBe("wasm");
    setRar5Config({ backend: "bogus" as unknown as Rar5Backend });
    expect(resolveRar5Backend()).toBe("auto");
  });
});

describe("snappy backend selection", () => {
  it("defaults to auto", () => {
    expect(resolveSnappyBackend()).toBe("auto");
  });

  it("prefers NAPI_RS_FORCE_WASI over the setting", () => {
    setSnappyConfig({ backend: "native" });
    process.env.NAPI_RS_FORCE_WASI = "error";
    expect(resolveSnappyBackend()).toBe("wasm");
  });

  it("honours the injected setting", () => {
    setSnappyConfig({ backend: "native" });
    expect(resolveSnappyBackend()).toBe("native");
    setSnappyConfig({ backend: "wasm" });
    expect(resolveSnappyBackend()).toBe("wasm");
    setSnappyConfig({ backend: "bogus" as unknown as SnappyBackend });
    expect(resolveSnappyBackend()).toBe("auto");
  });
});

describe("backend integration", () => {
  it.runIf(fs.existsSync(SNAPPY_WASM))(
    "snappy WASM backend round-trips via the setting",
    async () => {
      setSnappyConfig({ backend: "wasm" });
      const data = Buffer.from("backend wasm ".repeat(64));
      const compressed = await snappyCompress(data);
      expect(compressed.length).toBeGreaterThan(0);
      const restored = await snappyDecompress(compressed);
      expect(Buffer.from(restored).equals(data)).toBe(true);
    },
  );

  it.runIf(fs.existsSync(RAR5_WASM))(
    "rar5 WASM backend creates an archive via the setting",
    async () => {
      setRar5Config({ backend: "wasm" });
      const td = fs.mkdtempSync(path.join(os.tmpdir(), "sat_backend_"));
      try {
        const src = path.join(td, "a.txt");
        fs.writeFileSync(src, "backend wasm rar");
        const out = path.join(td, "out.rar");
        await compressWithRar5(
          {
            format: {
              label: "rar",
              description: "",
              canCreate: true,
              supportsEncryption: true,
            },
            outputPath: out,
            targets: [{ fsPath: src }],
            password: "",
            level: 3,
          },
          undefined,
          undefined,
          [],
        );
        expect(fs.existsSync(out)).toBe(true);
        const head = fs.readFileSync(out).subarray(0, RAR5_SIG.length);
        expect(head.equals(RAR5_SIG)).toBe(true);
      } finally {
        fs.rmSync(td, { recursive: true, force: true });
      }
    },
  );
});
