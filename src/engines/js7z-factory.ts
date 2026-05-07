/**
 * js7z factory — Smart Archive VSCode Extension
 *
 * Wraps the CommonJS js7z-tools module so all other modules
 * import from one place.
 *
 * @module engines/js7z-factory
 */

import type { JS7zFactory } from "../types";

// js7z-tools is a CommonJS module with `export = factory`.
// TypeScript esModuleInterop handles the import correctly.
export const JS7z: JS7zFactory = require("js7z-tools");
