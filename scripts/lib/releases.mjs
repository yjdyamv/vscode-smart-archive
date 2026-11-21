// Single source of truth for the 7-Zip ZS native release. Bump the tag here,
// then regenerate the pinned hashes with SA_HASH_BOOTSTRAP=1 in the installer.
//
// The WASM engines are no longer staged by an installer: 7-Zip ZS WASM comes
// from the 7zip-zstd-wasm npm package and the rar5 binding (native + WASI)
// from @yjdyamv/rar-rs, so their versions live in package.json and are
// bumped with `npm install` (scripts/bump-deps.mjs does it).
export const SEVEN_ZIP_ZSTD_REPO = "yjdyamv/7-Zip-zstd-native";
export const SEVEN_ZIP_ZSTD_TAG = "v26.05-v1.5.7-R1";
