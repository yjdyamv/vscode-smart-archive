/**
 * Volume size core — Smart Archiver VSCode Extension
 *
 * Pure volume-size helpers (no vscode dependency) so worker threads and
 * the engine layer can use them. The config-dependent getVolumeSizes
 * lives in utils/volume-sizes.
 *
 * @module utils/volume-sizes-core
 */

/**
 * Built-in volume size presets — a short ladder, not a catalogue.
 *
 * These live here rather than in package.json's settings default on purpose: a
 * non-empty object default gets merged with the user's own keys in the settings
 * editor, so the list would read `100M … 4700M` followed by the user's sizes.
 * Keeping the default empty means the setting only ever shows what you wrote.
 *
 * Sizes are binary — `m` is MiB, `g` is GiB — which is what 7z's `-v` and the
 * RAR binding both mean, so a label is the value and what you pick is exactly
 * what lands on disk.
 */
export const VOLUME_SIZES = [
  { label: "100M", value: "100m" },
  { label: "700M", value: "700m" },
  { label: "1G", value: "1g" },
  { label: "2G", value: "2g" },
  { label: "4700M", value: "4700m" },
];

/**
 * Normalize a volume size into the form 7z's `-v` accepts.
 *
 * 7z takes an integer plus one of `b`/`k`/`m`/`g`, so a fractional size ("1.1m",
 * typed into the wizard) cannot stay in `m`: it goes out as exact binary bytes
 * ("1153433b"). Passing `-v1.1m` through makes 7z reject the whole command and
 * write nothing at all.
 *
 * Sizes are binary throughout — `m` is MiB, `g` is GiB — which is what 7z's `-v`
 * and the RAR binding both mean, so what the user types is what lands on disk.
 *
 * - `"1440k"` → `"1440k"` (already a whole number)
 * - `"700m"`  → `"700m"`  (integer sizes are literal: m is MiB)
 * - `"1.1m"`  → `"1153433b"` (fractional → exact bytes)
 */
export function toBinaryVolumeSize(value: string): string {
  const m = value.match(/^(\d+(?:\.\d+)?)(k|m|g)$/i);
  if (!m) return value;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return value;
  if (Number.isInteger(num)) return value;
  const mult =
    m[2].toLowerCase() === "g" ? 1_073_741_824 : m[2].toLowerCase() === "m" ? 1_048_576 : 1024;
  return `${Math.floor(num * mult)}b`;
}

export function describeVolume(_label: string, value: string): string | undefined {
  const actual = toBinaryVolumeSize(value);
  return actual === value ? undefined : `actual: ${actual}`;
}

export type VolumeSizeItem = { label: string; value: string; description?: string };
