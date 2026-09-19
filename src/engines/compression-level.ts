/**
 * The host's effective default compression level, on the UI's 0–9 scale
 * (`smart-archiver.default.compressionLevel`, `LEVEL_VALUES`).
 *
 * Injected once per activation, per settings change and per worker init by
 * `applyEngineConfig`, and read by every engine that needs a *default*: the
 * wrapped-tar codecs (zstd/brotli) and the rar5 append path. Engine-specific
 * scales are derived at the use site — `mapLevel`, `mapZstdLevel`,
 * `mapLizardLevel` — so the UI scale stays the single source and no engine
 * invents its own default (the rar5 append path used to hardcode rar level 3,
 * which silently ignored the setting).
 */
import { DEFAULT_COMPRESSION_LEVEL } from "../constants";

let _level = DEFAULT_COMPRESSION_LEVEL;

/** Set the effective level (UI scale 0–9); non-numeric input is ignored. */
export function setCompressionLevel(level: number): void {
  if (typeof level === "number" && Number.isFinite(level)) _level = level;
}

/** The effective level on the UI scale (0–9). */
export function currentCompressionLevel(): number {
  return _level;
}

/** Reset to the shipped default (tests, and a config that omits the key). */
export function resetCompressionLevel(): void {
  _level = DEFAULT_COMPRESSION_LEVEL;
}
