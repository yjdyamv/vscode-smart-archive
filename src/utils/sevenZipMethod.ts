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

/**
 * `-m0=` parameter for the XZ container, or undefined to keep the default.
 *
 * The XZ format only defines the LZMA2 filter — FLZMA2/ZSTD/BROTLI/LZ4/
 * LIZARD are rejected by both bundled engines with E_INVALIDARG ("parameter
 * error"), so the 7z method cannot be forwarded as-is. The `flzma2` setting
 * (the default) maps to LZMA2 with the HC4 hash-chain match finder: the
 * same "fast LZMA2" idea, ~4x faster than BT4 with ~2% larger output, and
 * still a standard LZMA2 stream every xz decoder accepts. Any other method
 * leaves the encoder default (LZMA2/BT4) untouched.
 */
export function xzMethodParam(method: SevenZipMethod | undefined): string | undefined {
  return method === "flzma2" ? "LZMA2:mf=hc4" : undefined;
}

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
