/**
 * Public API — Smart Archiver VSCode Extension
 *
 * Programmatic entry point for compression and decompression operations.
 * These functions are VSCode-agnostic and can be called from:
 *   - Extension commands (production UI layer)
 *   - Test suites (automated verification)
 *   - External tooling (CI pipelines, batch scripts)
 *
 * All functions accept and return plain objects and strings;
 * no VSCode types appear in the public interface.
 *
 * @module api/index
 */

export {
  compress,
  lookupFormat,
  resolveOutputPath,
  resolveSaveName,
  buildCompressOptions,
  validateTargetPaths,
} from "./compress";
export type { CompressParams } from "./compress";

export {
  decompress,
  deriveOutputDir,
  resolveArchiveExt,
  detectEncryption,
  resolveEffectiveInput,
  validateArchive,
} from "./decompress";
export type { DecompressParams } from "./decompress";
