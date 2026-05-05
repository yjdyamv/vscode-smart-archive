/**
 * js7z factory — Smart Archive VSCode Extension
 *
 * Single require() wrapper for js7z-tools (CommonJS).
 * All other modules import from here — no eslint-disable comments elsewhere.
 *
 * @module engines/js7z-factory
 */

import type { JS7zFactory } from "../types";

// js7z-tools is a CommonJS module with `export = factory`.
// TypeScript esModuleInterop handles the import correctly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const JS7z: JS7zFactory = require("js7z-tools");
