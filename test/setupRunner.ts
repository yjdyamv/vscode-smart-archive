/**
 * Vitest setup — force the in-process archive runner and reset the vscode
 * test double between tests.
 *
 * The engine dispatchers (js7z-compress / js7z-decompress) route through
 * the active runner; the worker-thread runner needs the built
 * out/worker/worker.js bundle, which does not exist under vitest.
 * Replace it with the in-process runner (runs the vscode-free core
 * directly, same code path the worker executes).
 *
 * __resetVscodeMock runs before every test so no test leaks configuration,
 * dialogs, pickers, or channels into the next — the suite no longer relies
 * on fileParallelism=false to hide shared mutable mock state.
 */

import { beforeEach } from "vitest";
import { setArchiveRunner, InProcessRunner } from "../src/engines/worker/runner";
import { __resetVscodeMock } from "./__mocks__/vscode";

setArchiveRunner(new InProcessRunner());

beforeEach(() => {
  __resetVscodeMock();
});
