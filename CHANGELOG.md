# Changelog

All notable changes to the Smart Archive extension.

## [1.2.1] - 2025-04-29

### Fixed
- Eliminated shared `archivePassword` global; password now flows through function parameters
- Password stored from prompt is now passed to subsequent extract operations
- Removed dead RAR-to-7z fallback code path
- Fixed test runner to compile test TypeScript before execution
- Sanitize password/pw fields in pino logs to prevent credential leaks
- Cleaned `.vscodeignore` to remove dead entries and add `*.vsix` exclusion
- Zip bomb protection: check reported file size before reading data from WASM
- CJK filename encoding fix via `iconv-lite` (CP437/GBK mojibake recovery)
- Progress bar now uses delta increment instead of absolute percentage
- Reverted from pnpm to npm for packaging (vsce incompatible with pnpm)

### Added
- User configuration options: default format, compression level, output directory
- Keyboard shortcuts: `Ctrl+Alt+C` (compress), `Ctrl+Alt+D` (decompress), `Ctrl+Alt+B` (browse)
- Ctrl+A select all in archive browser webview

## [1.2.0] - 2025-04-27

### Added
- Archive browser with custom editor (tree view, checkbox selection, partial extract)
- Support for browsing `.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tar.zst`, `.tar.lz`, `.tgz`, `.tbz2`, `.txz`, `.tzst`, `.wim`, `.zst` archives
- Browse command in context menu and command palette

### Fixed
- oxfmt formatting for CI compliance

## [1.1.0] - 2025-04-25

### Added
- Zstandard (zstd) compression via `@bokuweb/zstd-wasm`
- CJK filename encoding fix (CP437/GBK recovery via `iconv-lite`)
- WIM compression support
- Archive browser webview with partial extraction
- Structured logging via pino
- Security: Zip Slip path traversal protection, zip bomb size limits
- Internationalization (English / Chinese)

### Changed
- Switched to pnpm for package management (later reverted)
- Improved progress indicators during operations
- Refactored format registry into a single `FORMAT_TABLE` in `constants.ts`

## [1.0.0] - 2025-04-20

### Added
- Initial release
- Compress to 7z, ZIP, TAR, GZip, BZip2, XZ
- Decompress from 30+ formats (7z, ZIP, RAR v4/v5, TAR, CAB, ISO, VHD, DEB, RPM, etc.)
- AES-256 encryption for 7z and ZIP archives
- Context menu integration
- Two-engine architecture: `js7z-tools` (7-Zip WASM) + `libarchive-wasm` (RAR)
- Automatic engine fallback on extraction failure
