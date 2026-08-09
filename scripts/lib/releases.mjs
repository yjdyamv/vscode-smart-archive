// Single source of truth for the 7-Zip ZS release shared by the native and
// WASM install scripts. Bump the tag here, then regenerate the pinned hashes
// with SA_HASH_BOOTSTRAP=1 in both installers.
export const SEVEN_ZIP_ZSTD_REPO = "yjdyamv/7-Zip-zstd-native";
export const SEVEN_ZIP_ZSTD_WASM_REPO = "yjdyamv/7-Zip-zstd-wasm";
export const SEVEN_ZIP_ZSTD_TAG = "v26.02-v1.5.7-R2";
