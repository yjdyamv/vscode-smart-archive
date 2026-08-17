/**
 * Archive worker — Smart Archiver VSCode Extension
 *
 * worker_threads entry that runs the WASM 7-Zip compress/decompress
 * pipelines off the extension host. Vscode-free by construction —
 * everything it needs (locale, size limits, zstd setting) arrives via
 * init/reconfigure messages; progress/log/notify flow back over the port.
 *
 * Bundled as out/worker/worker.js (see vite.extension.config.ts).
 *
 * @module engines/worker/worker
 */

import { parentPort } from "worker_threads";
import { createArchiveWorkerHandler } from "./handler";

if (!parentPort) {
  throw new Error("archive worker must be started via worker_threads");
}

createArchiveWorkerHandler(parentPort);
