/**
 * Volume size core — Smart Archiver VSCode Extension
 *
 * Pure volume-size helpers (no vscode dependency) so worker threads and
 * the engine layer can use them. The config-dependent getVolumeSizes
 * lives in utils/volume-sizes.
 *
 * @module utils/volume-sizes-core
 */

/** Built-in volume size presets */
export const VOLUME_SIZES = [
  { label: "1.44M", value: "1440k" },
  { label: "10M", value: "10m" },
  { label: "25M", value: "25m" },
  { label: "50M", value: "50m" },
  { label: "100M", value: "100m" },
  { label: "200M", value: "200m" },
  { label: "650M", value: "650m" },
  { label: "700M", value: "700m" },
  { label: "1G", value: "1g" },
  { label: "2G", value: "2g" },
  { label: "4.7G", value: "4700m" },
];

/**
 * Convert a volume size from decimal-advertised units to safe binary units
 * for use with 7z `-v`. Storage media (CD-R, DVD-R, HDD) use 1 MB = 1,000,000
 * bytes while 7z uses 1 m = 1 MiB = 1,048,576 bytes.  Rounds down (floor) so
 * the archive always fits inside the advertised media capacity.
 *
 * - `"1440k"` → `"1440k"` (k is identical in both systems)
 * - `"650m"`  → `"619m"`  (650 MB decimal ≈ 619 MiB binary)
 * - `"1g"`    → `"953m"`  (1 GB decimal ≈ 953 MiB binary, not an integer GiB)
 */
export function toBinaryVolumeSize(value: string): string {
  const m = value.match(/^(\d+)(k|m|g)$/i);
  if (!m) return value;
  if (m[2].toLowerCase() === "k") return value;
  const num = parseInt(m[1], 10);
  const decimalBytes = m[2].toLowerCase() === "g" ? num * 1_000_000_000 : num * 1_000_000;
  const binaryMib = Math.floor(decimalBytes / 1_048_576);
  return binaryMib > 0 ? `${binaryMib}m` : value;
}

export function describeVolume(label: string, value: string): string | undefined {
  const actual = toBinaryVolumeSize(value);
  if (actual === value) return undefined;
  return `actual: ${actual}`;
}

export type VolumeSizeItem = { label: string; value: string; description?: string };
