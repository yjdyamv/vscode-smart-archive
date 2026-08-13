/**
 * run7z crash-vs-warning contract tests — Smart Archive VSCode Extension
 *
 * Locks the fix for "WASM crash reported as success": a synchronous
 * callMain throw (engine crash / memory-guard OOM) must reject the run,
 * while the genuine 7-Zip exit code 1 (non-fatal warning) keeps resolving
 * — and a crash must never fire onExit at all (the factory wrapper's
 * contract), so no caller can mistake it for a warning.
 *
 * Uses a fake JS7zInstance replicating the factory's callMain wrapper
 * semantics (sync onExit on return, no onExit on throw), so no WASM
 * engine is needed.
 *
 * @module test/run7z
 */

import { describe, it, expect } from "vitest";
import { run7z } from "../src/engines/js7z-helpers";
import type { JS7zInstance } from "../src/types";

type Mode = "ok" | "warning" | "crash";

function makeJs7z(mode: Mode): { js7z: JS7zInstance; exitCalls: number[] } {
  const exitCalls: number[] = [];
  let onExit: ((code: number) => void) | null = null;
  const js7z = {
    print: undefined as unknown,
    printErr: undefined as unknown,
    get onExit() {
      return onExit;
    },
    set onExit(fn: ((code: number) => void) | null) {
      onExit = fn;
    },
    callMain: () => {
      if (mode === "crash") throw new Error("worker memory limit exceeded");
      const code = mode === "warning" ? 1 : 0;
      // The factory wrapper fires onExit synchronously on a normal return —
      // and never on a throw.
      exitCalls.push(code);
      onExit?.(code);
      return code;
    },
  } as unknown as JS7zInstance;
  return { js7z, exitCalls };
}

describe("run7z exit-code contract", () => {
  it("resolves on exit code 0", async () => {
    const { js7z, exitCalls } = makeJs7z("ok");
    await expect(run7z(js7z, ["x"])).resolves.toBeUndefined();
    expect(exitCalls).toEqual([0]);
  });

  it("resolves on exit code 1 (7-Zip non-fatal warning semantics)", async () => {
    const { js7z, exitCalls } = makeJs7z("warning");
    await expect(run7z(js7z, ["x"])).resolves.toBeUndefined();
    expect(exitCalls).toEqual([1]);
  });

  it("rejects when callMain throws (crash must never look like a warning)", async () => {
    const { js7z, exitCalls } = makeJs7z("crash");
    await expect(run7z(js7z, ["x"])).rejects.toThrow(/worker memory limit exceeded/);
    // The crash path must not have gone through onExit at all: no caller
    // may observe exit code 1 for a crash.
    expect(exitCalls).toEqual([]);
  });
});
