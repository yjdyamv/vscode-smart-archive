/**
 * Engine selection matrix — Smart Archive VSCode Extension
 *
 * selectEngine is the single place that decides which engine runs an
 * operation (system 7z / worker / rar5 / rar rebuild). The system-7z
 * detection primitives are mocked so the policy is tested deterministically
 * — the real probes are covered by system7z's own tests.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EngineChoice } from "../src/engines/select-engine";

vi.mock("../src/engines/system7z", () => ({
  hasSystem7z: vi.fn(() => true),
  hasSystem7zForFormat: vi.fn(() => true),
  system7zCanDecompress: vi.fn(() => true),
}));

import { selectEngine } from "../src/engines/select-engine";
import { hasSystem7z, hasSystem7zForFormat, system7zCanDecompress } from "../src/engines/system7z";

const mockedHasSystem7z = vi.mocked(hasSystem7z);
const mockedHasSystem7zForFormat = vi.mocked(hasSystem7zForFormat);
const mockedSystem7zCanDecompress = vi.mocked(system7zCanDecompress);

/** Restore every mock to the "system 7z fully available" default. */
function systemAvailable(): void {
  mockedHasSystem7z.mockReturnValue(true);
  mockedHasSystem7zForFormat.mockReturnValue(true);
  mockedSystem7zCanDecompress.mockReturnValue(true);
}

function expectChoice(
  request: Parameters<typeof selectEngine>[0],
  engine: EngineChoice,
): void {
  const sel = selectEngine(request);
  expect(sel.engine).toBe(engine);
  expect(sel.reason.length).toBeGreaterThan(0);
}

describe("selectEngine · compress", () => {
  beforeEach(() => systemAvailable());

  it("routes RAR creation to the rar5 binding (label without dot)", () => {
    expectChoice({ op: "compress", ext: "rar" }, "rar5");
    expectChoice({ op: "compress", ext: "RAR", password: "pw" }, "rar5");
  });

  it("uses system 7z for supported formats", () => {
    expectChoice({ op: "compress", ext: "zip" }, "system7z");
  });

  it("keeps system 7z when a password is set (fed via stdin, never argv)", () => {
    expectChoice({ op: "compress", ext: "zip", password: "secret" }, "system7z");
  });

  it("falls back to the worker when system 7z lacks the format", () => {
    mockedHasSystem7zForFormat.mockReturnValue(false);
    expectChoice({ op: "compress", ext: "tar.br" }, "worker");
  });
});

describe("selectEngine · decompress", () => {
  beforeEach(() => systemAvailable());

  it("uses system 7z when available and capable for the archive", () => {
    expectChoice(
      { op: "decompress", ext: ".7z", archivePath: "/tmp/a.7z" },
      "system7z",
    );
  });

  it("falls back to the worker when the archive uses unsupported methods", () => {
    mockedSystem7zCanDecompress.mockReturnValue(false);
    expectChoice(
      { op: "decompress", ext: ".7z", archivePath: "/tmp/a.7z" },
      "worker",
    );
  });

  it("keeps system 7z for encrypted archives (password via stdin)", () => {
    expectChoice(
      { op: "decompress", ext: ".7z", archivePath: "/tmp/a.7z", password: "pw" },
      "system7z",
    );
  });
});

describe("selectEngine · list / isEncrypted", () => {
  beforeEach(() => systemAvailable());

  it("routes wrapped formats to the worker", () => {
    expectChoice({ op: "list", ext: ".tar.gz" }, "worker");
  });

  it("uses system 7z for plain formats on disk", () => {
    expectChoice({ op: "list", ext: ".zip" }, "system7z");
  });

  it("routes in-memory data to the worker (no file to read)", () => {
    expectChoice({ op: "list", ext: ".zip", hasData: true }, "worker");
  });

  it("routes isEncrypted to system 7z when available", () => {
    expectChoice({ op: "isEncrypted", ext: ".7z" }, "system7z");
    mockedHasSystem7z.mockReturnValue(false);
    expectChoice({ op: "isEncrypted", ext: ".7z" }, "worker");
  });
});

describe("selectEngine · archive mutation (add/delete/rename)", () => {
  beforeEach(() => systemAvailable());

  for (const op of ["add", "delete", "rename"] as const) {
    it(`rebuilds RAR archives (${op})`, () => {
      expectChoice({ op, ext: ".rar" }, "rarRebuild");
      expectChoice({ op, ext: ".r01" }, "rarRebuild");
    });

    it(`mutates wrapped formats in the worker (${op})`, () => {
      expectChoice({ op, ext: ".tar.zst" }, "worker");
    });

    it(`uses system 7z for plain formats (${op})`, () => {
      expectChoice({ op, ext: ".zip" }, "system7z");
    });

    it(`keeps system 7z when encrypted (password via stdin) (${op})`, () => {
      expectChoice({ op, ext: ".zip", password: "pw" }, "system7z");
    });
  }
});

describe("selectEngine · createFolder / preview", () => {
  beforeEach(() => systemAvailable());

  it("rebuilds RAR archives, otherwise always the worker", () => {
    expectChoice({ op: "createFolder", ext: ".rar" }, "rarRebuild");
    expectChoice({ op: "createFolder", ext: ".zip" }, "worker");
  });

  it("offers the system fast path for preview when capable", () => {
    expectChoice({ op: "preview", ext: ".zip" }, "system7z");
    mockedHasSystem7zForFormat.mockReturnValue(false);
    expectChoice({ op: "preview", ext: ".tar.br" }, "worker");
  });
});
