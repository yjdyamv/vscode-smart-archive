/**
 * rar5 / snappy backend selection — Smart Archive
 *
 * Both codecs can run on the native Node binding or the WASM engine.
 * `smart-archive.rar5Backend` / `smart-archive.snappyBackend` (auto /
 * native / wasm) are injected via applyEngineConfig (the single config
 * interface shared by host and worker); the legacy env overrides
 * (SA_RAR5_FORCE_WASM / NAPI_RS_FORCE_WASI) still win.
 * Integration cases verify the setting alone can force the WASM engine.
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveRar5Backend,
  resetRar5BindingCache,
  compressWithRar5,
  type Rar5Backend,
} from "../src/engines/rar5-engine";
import {
  resolveSnappyBackend,
  resetSnappyBindingCache,
  snappyCompress,
  snappyDecompress,
  type SnappyBackend,
} from "../src/engines/snappy-codec";
import { applyEngineConfig, DEFAULT_ENGINE_CONFIG } from "../src/engines/engine-config";
import type { EngineConfig } from "../src/engines/worker/types";
import { gate } from "./gates";
import { tmpDir } from "./tmp";


const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

const NOOP_WARN = { warn: () => {} };

function applyBackends(config: Partial<EngineConfig>): void {
  applyEngineConfig({ ...DEFAULT_ENGINE_CONFIG, ...config }, NOOP_WARN);
}

afterEach(() => {
  applyBackends({});
  resetRar5BindingCache();
  resetSnappyBindingCache();
  delete process.env.SA_RAR5_FORCE_WASM;
  delete process.env.NAPI_RS_FORCE_WASI;
});

describe("rar5 backend selection", () => {
  it("defaults to auto", () => {
    applyBackends({});
    expect(resolveRar5Backend()).toBe("auto");
  });

  it("prefers SA_RAR5_FORCE_WASM=1 over the setting", () => {
    applyBackends({ rar5Backend: "native" });
    process.env.SA_RAR5_FORCE_WASM = "1";
    expect(resolveRar5Backend()).toBe("wasm");
  });

  it("honours the injected setting", () => {
    applyBackends({ rar5Backend: "native" });
    expect(resolveRar5Backend()).toBe("native");
    applyBackends({ rar5Backend: "wasm" });
    expect(resolveRar5Backend()).toBe("wasm");
    applyBackends({ rar5Backend: "bogus" as unknown as Rar5Backend });
    expect(resolveRar5Backend()).toBe("auto");
  });
});

describe("snappy backend selection", () => {
  it("defaults to auto", () => {
    applyBackends({});
    expect(resolveSnappyBackend()).toBe("auto");
  });

  it("prefers NAPI_RS_FORCE_WASI over the setting", () => {
    applyBackends({ snappyBackend: "native" });
    process.env.NAPI_RS_FORCE_WASI = "error";
    expect(resolveSnappyBackend()).toBe("wasm");
  });

  it("honours the injected setting", () => {
    applyBackends({ snappyBackend: "native" });
    expect(resolveSnappyBackend()).toBe("native");
    applyBackends({ snappyBackend: "wasm" });
    expect(resolveSnappyBackend()).toBe("wasm");
    applyBackends({ snappyBackend: "bogus" as unknown as SnappyBackend });
    expect(resolveSnappyBackend()).toBe("auto");
  });
});

describe("backend integration", () => {
  it.runIf(gate("snappyWasm"))(
    "snappy WASM backend round-trips via the setting",
    async () => {
      applyBackends({ snappyBackend: "wasm" });
      const data = Buffer.from("backend wasm ".repeat(64));
      const compressed = await snappyCompress(data);
      expect(compressed.length).toBeGreaterThan(0);
      const restored = await snappyDecompress(compressed);
      expect(Buffer.from(restored).equals(data)).toBe(true);
    },
  );

  it.runIf(gate("rar5Wasm"))(
    "rar5 WASM backend creates an archive via the setting",
    async () => {
      applyBackends({ rar5Backend: "wasm" });
      const td = tmpDir("sat_backend_");
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
