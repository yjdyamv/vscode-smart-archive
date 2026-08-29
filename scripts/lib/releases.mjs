// Single source of truth for the 7-Zip ZS release shared by the native and
// WASM install scripts. Bump the tag here, then regenerate the pinned hashes
// with SA_HASH_BOOTSTRAP=1 in both installers.
export const SEVEN_ZIP_ZSTD_REPO = "yjdyamv/7-Zip-zstd-native";
export const SEVEN_ZIP_ZSTD_WASM_REPO = "yjdyamv/7-Zip-zstd-wasm";
export const SEVEN_ZIP_ZSTD_TAG = "v26.02-v1.5.7-R2";

// Single source of truth for the rar5 binding (smart-archive-rar) release.
// The version is pinned in-repo on purpose: the installer's EXPECTED_HASHES
// are bound to a specific release, so a floating "latest release" resolution
// would make every new upstream release break fresh installs and CI builds
// (hash mismatch, fail-closed) until the pins are regenerated. Bump the
// version here, then regenerate the pinned hashes with SA_HASH_BOOTSTRAP=1.
// SA_RAR5_VERSION still overrides this for one-off experiments.
export const RAR5_REPO = "yjdyamv/rar-rs";
export const RAR5_VERSION = "0.4.0";
