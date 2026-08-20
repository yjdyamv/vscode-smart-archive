/**
 * Engine runtime-fallback tests — Smart Archiver
 *
 * Verifies the "auto" backend promise: when the selected system-7z binary
 * exists and passes detection but FAILS at runtime, the compress/decompress
 * dispatchers retry with the WASM worker instead of surfacing a hard error.
 * Explicit native/bundled settings keep their chosen binary and propagate
 * the failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

vi.mock("../src/engines/system7z", () => ({
  compressWithSystem7z: vi.fn(),
  decompressWithSystem7z: vi.fn(),
  unwrapInnerTarsWithSystem7z: vi.fn(),
}));
vi.mock("../src/engines/select-engine", () => ({
  selectEngine: vi.fn(() => ({ engine: "system7z", reason: "test-mock" })),
}));
vi.mock("../src/engines/worker/runner", () => ({
  runArchiveOp: vi.fn(),
}));

import { compressWith7z } from "../src/engines/js7z-compress";
import { decompressWith7z } from "../src/engines/js7z-decompress";
import { CancelledError, isCancellationError } from "../src/utils/cancellation";
import {
  compressWithSystem7z,
  decompressWithSystem7z,
  unwrapInnerTarsWithSystem7z,
} from "../src/engines/system7z";
import { runArchiveOp } from "../src/engines/worker/runner";

const compressWithSystem7zMock = vi.mocked(compressWithSystem7z);
const decompressWithSystem7zMock = vi.mocked(decompressWithSystem7z);
const unwrapInnerTarsWithSystem7zMock = vi.mocked(unwrapInnerTarsWithSystem7z);
const runArchiveOpMock = vi.mocked(runArchiveOp);

const compressOptions = {
  targets: [{ fsPath: "/a/b" }],
  format: { label: "7z", exts: [".7z"], canCreate: true, supportsEncryption: true, category: "archive" },
  outputPath: "/out/a.7z",
  password: "",
  level: 5,
} as never;

const decompressOptions = {
  inputPath: "/in/a.7z",
  outputDir: "/out/dir",
  password: "",
} as never;

beforeEach(() => {
  (vscode as never as { __resetVscodeMock: () => void }).__resetVscodeMock();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("compress runtime fallback", () => {
  it("auto backend retries with the WASM worker when system 7z fails at runtime", async () => {
    compressWithSystem7zMock.mockRejectedValue(new Error("boom"));
    (vscode as never as { __setConfig: (s: string, k: string, v: unknown) => void }).__setConfig(
      "smart-archiver",
      "backend.7z",
      "auto",
    );

    await compressWith7z(compressOptions);

    expect(runArchiveOpMock).toHaveBeenCalledTimes(1);
    expect(runArchiveOpMock).toHaveBeenCalledWith(
      "compress",
      { options: compressOptions, excludePatterns: undefined },
      undefined,
      undefined,
    );
  });

  it("explicit native backend propagates the runtime failure without falling back", async () => {
    compressWithSystem7zMock.mockRejectedValue(new Error("boom"));
    (vscode as never as { __setConfig: (s: string, k: string, v: unknown) => void }).__setConfig(
      "smart-archiver",
      "backend.7z",
      "native",
    );

    await expect(compressWith7z(compressOptions)).rejects.toThrow("boom");
    expect(runArchiveOpMock).not.toHaveBeenCalled();
  });

  it("explicit bundled backend propagates the runtime failure without falling back", async () => {
    compressWithSystem7zMock.mockRejectedValue(new Error("boom"));
    (vscode as never as { __setConfig: (s: string, k: string, v: unknown) => void }).__setConfig(
      "smart-archiver",
      "backend.7z",
      "bundled",
    );

    await expect(compressWith7z(compressOptions)).rejects.toThrow("boom");
    expect(runArchiveOpMock).not.toHaveBeenCalled();
  });

  it("cancellation errors are preserved and never trigger a fallback", async () => {
    compressWithSystem7zMock.mockRejectedValue(new CancelledError());
    (vscode as never as { __setConfig: (s: string, k: string, v: unknown) => void }).__setConfig(
      "smart-archiver",
      "backend.7z",
      "auto",
    );

    await expect(compressWith7z(compressOptions)).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(runArchiveOpMock).not.toHaveBeenCalled();
  });

  it("recognises the American-spelling vscode CancellationError name", () => {
    const err = new Error("canceled");
    err.name = "Canceled";
    expect(isCancellationError(err)).toBe(true);
  });
});

describe("decompress runtime fallback", () => {
  it("auto backend retries with the WASM worker when system 7z fails at runtime", async () => {
    decompressWithSystem7zMock.mockRejectedValue(new Error("boom"));
    (vscode as never as { __setConfig: (s: string, k: string, v: unknown) => void }).__setConfig(
      "smart-archiver",
      "backend.7z",
      "auto",
    );

    await decompressWith7z(decompressOptions);

    expect(runArchiveOpMock).toHaveBeenCalledTimes(1);
    expect(runArchiveOpMock).toHaveBeenCalledWith(
      "decompress",
      { options: decompressOptions },
      undefined,
      undefined,
    );
  });

  it("auto backend retries when inner-tar unwrap fails after a successful extract", async () => {
    decompressWithSystem7zMock.mockResolvedValue(undefined);
    unwrapInnerTarsWithSystem7zMock.mockRejectedValue(new Error("unwrap boom"));
    (vscode as never as { __setConfig: (s: string, k: string, v: unknown) => void }).__setConfig(
      "smart-archiver",
      "backend.7z",
      "auto",
    );

    await decompressWith7z(decompressOptions);

    expect(runArchiveOpMock).toHaveBeenCalledTimes(1);
    expect(runArchiveOpMock).toHaveBeenCalledWith(
      "decompress",
      { options: decompressOptions },
      undefined,
      undefined,
    );
  });

  it("explicit native backend propagates the runtime failure without falling back", async () => {
    decompressWithSystem7zMock.mockRejectedValue(new Error("boom"));
    (vscode as never as { __setConfig: (s: string, k: string, v: unknown) => void }).__setConfig(
      "smart-archiver",
      "backend.7z",
      "native",
    );

    await expect(decompressWith7z(decompressOptions)).rejects.toThrow("boom");
    expect(runArchiveOpMock).not.toHaveBeenCalled();
  });
});