# Smart Archiver

[![Build](https://github.com/yjdyamv/vscode-smart-archive/actions/workflows/build.yml/badge.svg)](https://github.com/yjdyamv/vscode-smart-archive/actions/workflows/build.yml)

VSCode extension for creating, extracting, and browsing archives — powered by a **bundled native 7-Zip** (with a **7-Zip WebAssembly** fallback) and native **zstd/lz4/brotli** codecs (brotli via Node.js zlib), with the WASM engine as the final fallback. Works out of the box with no local 7-Zip install, at near-desktop speed.

> **Renamed from `smart-archive` to `smart-archiver`:** the previous marketplace
> listing (`yjdyamv.smart-archive`) was deleted and its name can no longer be
> republished, so this extension ships under the new ID `yjdyamv.smart-archiver`.
> If you are upgrading, re-apply your settings (the section is now
> `smart-archiver.*` instead of `smart-archive.*`) and re-bind any keybindings
> that referenced the old command IDs (e.g. `yjdyamv.smart-archive.compress`).

## Features

- **Compress** to 7z, ZIP, RAR5, TAR, WIM, tar.gz, tar.bz2, tar.xz, tar.zst, tar.lz4, tar.br, tar.sz
- **Decompress** from 40+ formats: 7z, ZIP, RAR (v4/v5), TAR, GZ, BZ2, XZ, CAB, ISO, VHD, DEB, RPM, ...
- **AES-256 encryption** — password-protect 7z, ZIP, and RAR5 archives (7z with header encryption, RAR5 with inline recovery records and recovery volumes)
- **Native 7-Zip engine** — the bundled 7-Zip binary covers Windows, Linux (x64/arm64) and macOS (arm64), no install needed; platforms without a native build (macOS x64, Linux arm, Windows ia32) fall back to the WASM engine. In `auto` mode the bundled binary is preferred; a system 7-Zip is used only when it is at least as capable (newer than the bundled fork with the same codecs). Choose explicitly via `smart-archiver.backend.7z` (`auto`/`native`/`bundled`/`wasm`)
- **Archive browser** — opens as the default editor for archives: virtual-scrolled tree, search with regex or fuzzy match, sort by name/size, multi-select for partial extract, add/delete/rename files right inside the view
- **Keyboard navigation** — Arrow keys, PageUp/PageDown (scroll viewport), Home/End, Space to toggle selection, Enter to extract, Delete to remove, Ctrl+A to select all
- **File preview** — double-click any file to open it in VS Code
- **Copy/paste** — select files in the archive browser, paste them to any local folder
- **Multi-volume support** — auto-resolves RAR `.r00`–`.r99` / `.partN.rar` and split 7z/zip `.001`–`.N` volumes
- **Bilingual UI** — English / Simplified Chinese / Traditional Chinese (auto-detected from VS Code locale)
- **Large file handling** — archives and files beyond 2 GiB via chunked I/O (2 GiB file boundary split into 100 MB chunks)
- **Security** — Zip Slip protection, configurable size limits (k/m/g units), path traversal blocking, decompression bomb detection
- **Smart exclude** — automatically skips `node_modules`, `.git`, `dist`, `.venv`, and 30+ other noisy directories when compressing; customizable via settings
- **CJK filename recovery** — fixes GBK-encoded filenames in old archives (Shift-JIS / EUC-KR are byte-indistinguishable from GBK and not recoverable)
- **Context menu integration** — right-click files to compress, right-click archives to decompress or browse

## Quick Start

```bash
npm install               # installs root + webview-ui deps
npm run build             # build Vue frontend + extension
```

Press `F5` in VS Code to launch the Extension Development Host.

> **Development note:** building/developing this repository runs
> `stage:natives`, which downloads and unpacks the bundled 7-Zip binaries.
> A fresh checkout therefore needs 7-Zip installed locally to bootstrap the
> staging — **required on Windows** (install from
> https://www.7-zip.org/), recommended on Linux/macOS (`p7zip`/`7zz` via
> your package manager). End users do **not** need a local 7-Zip: the VSIX
> already bundles the binaries.

## Usage

| Action | How |
|--------|-----|
| Compress | Right-click file(s)/folder(s) → `Smart Archiver: Compress` → pick format → optional password → save |
| Decompress | Right-click archive → `Smart Archiver: Decompress` → optional password → extracts to `<name>.extracted/` |
| Browse | Right-click archive → `Smart Archiver: Browse Contents`, or double-click the archive file |

### Archive Browser Shortcuts

| Key | Action |
|-----|--------|
| `↑` `↓` | Move selection up/down (hold Shift to extend) |
| `PageUp` `PageDown` | Scroll viewport by one page + move selection |
| `Home` `End` | Jump to first/last item |
| `Space` | Toggle checkbox on anchor item |
| `Enter` | Extract selected items |
| `Delete` | Delete selected items |
| `F2` | Rename single selected item |
| `Ctrl+A` | Select all visible items |
| `Ctrl+C` | Copy selected paths |
| `Escape` | Clear selection / close context menu |

## Supported Formats

### Compression (create)

| Format | Encryption | Notes |
|--------|------------|-------|
| 7z | AES-256 | Best ratio, solid archive, header encryption |
| zip | AES-256 (7-Zip default) | Universal compatibility |
| rar | AES-256 | RAR5 creation, header encryption, multi-volume, recovery records |
| tar | — | No compression, archive only |
| tar.gz | — | TAR + GZip |
| tar.bz2 | — | TAR + BZip2 |
| tar.xz | — | TAR + XZ |
| tar.zst | — | TAR + Zstandard |
| tar.lz4 | — | TAR + LZ4 |
| tar.br | — | TAR + Brotli |
| tar.sz | — | TAR + Snappy |
| wim | — | Windows Imaging Format |

### Decompression (extract)

All formats supported by 7-Zip (including CAB, ARJ, LZH, CHM, MSI, ISO, VHD, VMDK, DEB, RPM, CPIO, UHA, XAR, DMG, FAT, NTFS, SquashFS, ...) — 40+ in total.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `smart-archiver.default.format` | `7z` | Default archive format |
| `smart-archiver.default.compressionLevel` | `5` | Compression level (0=store, 5=normal, 9=ultra) |
| `smart-archiver.limits.maxArchiveSize` | `"1g"` | Max size of the compressed archive file itself; warning threshold when the WASM fallback loads the whole archive into memory. Extraction and single-file preview can continue after confirmation |
| `smart-archiver.limits.maxExtractTotalSize` | `"10g"` | Max total size of all files after one extraction |
| `smart-archiver.backend.7z` | `"auto"` | 7-Zip engine: `auto` (bundled native→system, only if at least as capable→WASM), `native` (system only), `bundled` (bundled native only), `wasm` (WASM only) |
| `smart-archiver.backend.zstd` | `"auto"` | Zstd engine: `auto` (system→bundled native→WASM), `native` (system only), `bundled` (bundled native only), `wasm` (WASM only) |
| `smart-archiver.backend.brotli` | `"auto"` | Brotli engine: `auto`/`native` (Node.js zlib), `bundled` (bundled native 7-Zip), `wasm` (WASM only) |
| `smart-archiver.backend.lz4` | `"auto"` | LZ4 engine: `auto` (bundled native→WASM), `bundled` (bundled native only), `wasm` (WASM only) |
| `smart-archiver.backend.rar` | `"auto"` | RAR5 engine: `auto` (native binding→WASM), `native` (Node binding only), `wasm` (WASM only) |
| `smart-archiver.backend.snappy` | `"auto"` | Snappy (tar.sz): `auto` (native addon→WASM), `native` (Node addon only), `wasm` (WASM only) |
| `smart-archiver.patterns.collapsedDirs` | `[30+ patterns]` | Directory patterns kept collapsed in preview |
| `smart-archiver.patterns.compressExclude` | `[30+ patterns]` | Patterns excluded when compressing |
| `smart-archiver.volumes.sizes` | `[built-in presets]` | Custom split volume size presets (empty `{}` falls back to the built-in presets) |

## Requirements

- VS Code 1.85.0 or later
- System 7-Zip/zstd (**optional**, for faster operations):
  - Windows: `winget install 7zip zstd`
  - macOS: `brew install sevenzip zstd`
  - Linux: `apt install 7zip zstd` (or your package manager)

## Development

```bash
npm install              # installs root + webview-ui deps
npm run build            # build webview + compile (one step)
npm run watch            # watch the extension compile (F5 loop)
npm run dev:webview      # browser preview of the UI (localhost:5173, HMR, mock data)
npm run lint             # oxlint static analysis
npm run typecheck        # TypeScript type checking
npm run format           # oxfmt code formatting
npm run check            # format + lint + typecheck
npm run test             # vitest (extension tests)
npm --prefix webview-ui test   # vitest (webview UI tests)
npm run package:cross    # create .vsix (clean install + staged natives)
npm run release          # check + package:cross (pre-release validation)
```

> Quick dev workflow: `npm install` → `npm run build` → `F5` in VS Code.
>
> **UI development, two flows:**
>
> - **Browser preview (fastest):** `npm run dev:webview` serves the webview UI
>   at http://localhost:5173 with HMR and a mock archive (`webview-ui/src/devMock.ts`
>   simulates the host: lazy tree expansion, search, selection). No VS Code
>   needed — ideal for iterating on components.
> - **Real panel:** run the VS Code `watch` build task (extension compile +
>   webview rebuild on save; `npm run watch` alone covers the extension side),
>   press `F5` to open the Extension Development Host, open an archive, then
>   reload the webview panel (re-open the archive or
>   `Developer: Reload Window`) after each change.

## Dependencies

| Package | Purpose |
|---------|---------|
| [7-Zip ZS WebAssembly](https://github.com/yjdyamv/7-Zip-zstd-wasm) | Bundled WASM fallback (`vendor/7zz-wasm`, downloaded at install) — all compression & extraction; final fallback for zstd/brotli/lz4 |
| [7-Zip ZS native](https://github.com/yjdyamv/7-Zip-zstd-native) | Bundled native binary (`vendor/7z-bin`, staged at build) — main engine and the native fast path for zstd/lz4/brotli streams |
| [smart-archive-rar](https://github.com/yjdyamv/smart-archive-rar) | RAR5 creation engine — native napi-rs binding with a WASI (`wasm32-wasip1-threads`) fallback; AES-256, header encryption, multi-volume, recovery records, progress |
| [snappy](https://github.com/Brooooooklyn/snappy) | Snappy codec for tar.sz — napi-rs binding with a WASI fallback |
| Node.js `zlib` (built-in) | Brotli native fast path |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | CJK filename encoding recovery |
| [Vue 3](https://vuejs.org/) | Archive browser UI |
| [TanStack Virtual](https://tanstack.com/virtual) | Virtual scrolling for large archives |

## Security

- **Untrusted archives** — whenever a native 7-Zip is used (the bundled binary by default, or a system install), extraction refuses archives containing symbolic-link entries and enforces the configured size limits *before* writing, guarding against path-traversal writes and decompression bombs. The archive browser renders attacker-controlled entry names under a strict Content-Security-Policy.
- **Native vs sandboxed parsing** — by default (`auto`) archives are parsed by a native 7-Zip process, which is fast but runs C/C++ format handlers on untrusted input. To parse untrusted archives inside the WebAssembly sandbox instead, set `smart-archiver.backend.7z` to `wasm`.
- **Passwords on shared machines** — passwords are piped to native 7-Zip through stdin (`Enter password:` prompt), never passed as a command-line argument, so they do not appear in the process list. The WASM engine similarly keeps passwords inside the extension process.

## License

Proprietary. See [LICENSE](LICENSE).

## Acknowledgments

Thanks to everyone who contributed and the friendly community!
