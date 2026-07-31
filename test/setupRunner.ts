/**
 * Vitest setup — force the in-process archive runner.
 *
 * The engine dispatchers (js7z-compress / js7z-decompress) route through
 * the active runner; the worker-thread runner needs the built
 * out/worker/worker.js bundle, which does not exist under vitest.
 * Replace it with the in-process runner (runs the vscode-free core
 * directly, same code path the worker executes).
 */

import { setArchiveRunner, InProcessRunner } from "../src/engines/worker/runner";

setArchiveRunner(new InProcessRunner());
