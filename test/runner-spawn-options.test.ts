/**
 * Worker spawn options — Smart Archiver
 *
 * Regression: the archive worker must NOT inherit the host's `execArgv`.
 * Node's Worker inherits `process.execArgv` by default, and under the VS Code
 * debugger the extension host carries an inspector flag
 * (`--inspect-brk-extensions`). An inherited `--inspect-brk` made the spawned
 * thread wait for a debugger that never attached, so it never posted `ready`
 * and every wrapped-format write (tar.zst, tar.lz4, …) failed with a 30 s
 * "Archive worker did not become ready in time".
 *
 * @module test/runner-spawn-options
 */

import { describe, it, expect } from "vitest";
import { archiveWorkerOptions } from "../src/engines/worker/runner";

describe("archiveWorkerOptions", () => {
  it("clears execArgv so the worker cannot inherit a debugger inspector flag", () => {
    expect(archiveWorkerOptions().execArgv).toEqual([]);
  });

  it("keeps the JS-heap backstop via resourceLimits", () => {
    const limits = archiveWorkerOptions().resourceLimits as { maxOldGenerationSizeMb: number };
    expect(typeof limits.maxOldGenerationSizeMb).toBe("number");
    expect(limits.maxOldGenerationSizeMb).toBeGreaterThan(0);
  });
});
