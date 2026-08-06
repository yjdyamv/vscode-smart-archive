/**
 * 7z compression method shared by the native and WASM engines.
 *
 * Values map to `-m0=` codec names understood by the bundled 7-Zip ZS build.
 * Stock 7-Zip only knows LZMA2; FLZMA2 and ZSTD are fork extensions.
 *
 * @module utils/sevenZipMethod
 */

import type { SevenZipMethod } from "../types";

export const SEVEN_ZIP_METHOD_CODECS: Record<SevenZipMethod, string> = {
  lzma2: "LZMA2",
  flzma2: "FLZMA2",
  zstd: "ZSTD",
  brotli: "BROTLI",
  lz4: "LZ4",
  deflate: "Deflate",
  bzip2: "BZip2",
  lizard: "LIZARD",
};

/** Coerce a raw setting value into a known method; anything unknown → flzma2. */
export function normalizeSevenZipMethod(raw: unknown): SevenZipMethod {
  return raw === "lzma2" ||
    raw === "zstd" ||
    raw === "brotli" ||
    raw === "lz4" ||
    raw === "deflate" ||
    raw === "bzip2" ||
    raw === "lizard"
    ? raw
    : "flzma2";
}

/**
 * The bundled LizardMT codec only accepts levels 10–49 (its own scale),
 * while the extension's compression level is 0–9. Map the UI scale onto the
 * codec's range; level 0 is handled separately as Copy (store).
 */
export function mapLizardLevel(level: number): number {
  const l = Math.max(0, Math.min(9, Math.floor(level)));
  return 10 + Math.round((l * 39) / 9);
}
