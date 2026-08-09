# Smart Archive

[![Build](https://github.com/yjdyamv/vscode-smart-archive/actions/workflows/build.yml/badge.svg)](https://github.com/yjdyamv/vscode-smart-archive/actions/workflows/build.yml)

VSCode extension for creating, extracting, and browsing archives — powered by a **bundled native 7-Zip** (with a **7-Zip WebAssembly** fallback) and native **zstd/lz4 codecs** plus Node.js built-in **brotli**, with the bundled 7-Zip ZS WASM engine as the final fallback for zstd/brotli/lz4. Works out of the box with no local 7-Zip install, at near-desktop speed.

## Features

- **Compress** to 7z, ZIP, TAR, WIM, tar.gz, tar.bz2, tar.xz, tar.zst, tar.lz4, tar.br
- **Decompress** from 40+ formats: 7z, ZIP, RAR (v4/v5), TAR, GZ, BZ2, XZ, CAB, ISO, VHD, DEB, RPM, ...
- **AES-256 encryption** — password-protect 7z and ZIP archives
- **Native 7-Zip engine** — a full 7-Zip binary is bundled for all platforms (no install needed); a newer system 7-Zip is used automatically if present; the WASM engine is the final fallback. Choose explicitly via `smart-archive.sevenZBackend` (`auto`/`native`/`bundled`/`wasm`)
- **Archive browser** — opens as the default editor for archives: virtual-scrolled tree, search with regex or fuzzy match, sort by name/size, multi-select for partial extract, add/delete/rename files right inside the view
- **Keyboard navigation** — Arrow keys, PageUp/PageDown (scroll viewport), Home/End, Space to toggle selection, Enter to extract, Delete to remove, Ctrl+A to select all
- **File preview** — double-click any file to open it in VS Code
- **Copy/paste** — select files in the archive browser, paste them to any local folder
- **Multi-volume support** — auto-resolves RAR `.r00`–`.r99` and split 7z/zip `.001`–`.N` volumes
- **Bilingual UI** — English / Simplified Chinese / Traditional Chinese (auto-detected from VS Code locale)
- **Large file handling** — archives and files beyond 2 GiB via chunked I/O and NODEFS mount
- **Security** — Zip Slip protection, configurable size limits (k/m/g units), path traversal blocking, decompression bomb detection
- **Smart exclude** — automatically skips `node_modules`, `.git`, `dist`, `.venv`, and 30+ other noisy directories when compressing; customizable via settings
- **CJK filename recovery** — fixes GBK / Shift-JIS / EUC-KR encoded filenames in old archives
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
| Compress | Right-click file(s)/folder(s) → `Smart Archive: Compress` → pick format → optional password → save |
| Decompress | Right-click archive → `Smart Archive: Decompress` → optional password → extracts to `<name>.extracted/` |
| Browse | Right-click archive → `Smart Archive: Browse Contents`, or double-click the archive file |

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
| zip | AES-256 | Universal compatibility |
| tar | — | No compression, archive only |
| tar.gz | — | TAR + GZip |
| tar.bz2 | — | TAR + BZip2 |
| tar.xz | — | TAR + XZ |
| tar.zst | — | TAR + Zstandard |
| tar.lz4 | — | TAR + LZ4 |
| tar.br | — | TAR + Brotli |
| wim | — | Windows Imaging Format |

### Decompression (extract)

All formats supported by 7-Zip (including CAB, ISO, VHD, VMDK, DEB, RPM, CPIO, AR, DMG, FAT, NTFS, SquashFS, ...) — 40+ in total.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `smart-archive.defaultFormat` | `7z` | Default archive format |
| `smart-archive.defaultCompressionLevel` | `5` | Compression level (0=store, 5=normal, 9=ultra) |
| `smart-archive.maxArchiveSize` | `"1g"` | Max size of the compressed archive file itself; warning threshold when the WASM fallback loads the whole archive into memory. Extraction and single-file preview can continue after confirmation |
| `smart-archive.maxExtractTotalSize` | `"10g"` | Max total size of all files after one extraction |
| `smart-archive.sevenZBackend` | `"auto"` | 7-Zip engine: `auto` (system→bundled native→WASM), `native` (system only), `bundled` (bundled native only), `wasm` (WASM only) |
| `smart-archive.zstdBackend` | `"auto"` | Zstd engine: `auto` (system→bundled native→WASM), `native` (system only), `bundled` (bundled native only), `wasm` (WASM only) |
| `smart-archive.rar5Backend` | `"auto"` | RAR5 engine: `auto` (native binding→WASM), `native` (Node binding only), `wasm` (WASM only) |
| `smart-archive.snappyBackend` | `"auto"` | Snappy (tar.sz): `auto` (native addon→WASM), `native` (Node addon only), `wasm` (WASM only) |
| `smart-archive.collapsedDirPatterns` | `[30+ patterns]` | Directory patterns kept collapsed in preview |
| `smart-archive.compressExcludePatterns` | `[30+ patterns]` | Patterns excluded when compressing |
| `smart-archive.volumeSizes` | `{}` | Custom split volume size presets |

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
npm run watch            # watch mode: extension compile + webview rebuild
npm run dev:webview      # browser preview of the UI (localhost:5173, HMR, mock data)
npm run lint             # oxlint static analysis
npm run typecheck        # TypeScript type checking
npm run format           # oxfmt code formatting
npm run check            # format + lint + typecheck
npm run test             # vitest (extension + webview)
npm run clean            # remove build output
npm run package:cross    # create .vsix (clean install + staged natives)
npm run release          # build + check + package
```

> Quick dev workflow: `npm install` → `npm run build` → `F5` in VS Code.
>
> **UI development, two flows:**
>
> - **Browser preview (fastest):** `npm run dev:webview` serves the webview UI
>   at http://localhost:5173 with HMR and a mock archive (`src/devMock.ts`
>   simulates the host: lazy tree expansion, search, selection). No VS Code
>   needed — ideal for iterating on components.
> - **Real panel:** run `npm run watch` (extension compile + webview rebuild on
>   save), press `F5` to open the Extension Development Host, open an archive,
>   then reload the webview panel (re-open the archive or
>   `Developer: Reload Window`) after each change.

## Dependencies

| Package | Purpose |
|---------|---------|
| [7-Zip ZS 26.02 WebAssembly](https://github.com/yjdyamv/7-Zip-zstd-wasm) | Bundled WASM fallback (`vendor/7zz-wasm`, downloaded at install; all compression & extraction; parallel zstd, standard lz4; brotli backend configurable — node:zlib default / WASM / bundled 7z planned) |
| [smart-archive-rar](https://github.com/yjdyamv/smart-archive-rar) | RAR5 creation engine — native napi-rs binding with a WASI (`wasm32-wasip1-threads`) fallback; AES-256, header encryption, multi-volume, recovery records, progress |
| [zstd-napi](https://github.com/drakedevel/zstd-napi) | Zstandard compression fast path (decompression runs on WASM) |
| [lz4-napi](https://github.com/antoniomuso/lz4-napi) | LZ4 native binding used by tests/verification; runtime codec is WASM |
| Node.js `zlib` (built-in) | Brotli native binding used by tests/verification; runtime codec is WASM |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | CJK filename encoding recovery |
| [Vue 3](https://vuejs.org/) | Archive browser UI |
| [TanStack Virtual](https://tanstack.com/virtual) | Virtual scrolling for large archives |

## Security

- **Untrusted archives** — whenever a native 7-Zip is used (the bundled binary by default, or a system install), extraction refuses archives containing symbolic-link entries and enforces the configured size limits *before* writing, guarding against path-traversal writes and decompression bombs. The archive browser renders attacker-controlled entry names under a strict Content-Security-Policy.
- **Native vs sandboxed parsing** — by default (`auto`) archives are parsed by a native 7-Zip process, which is fast but runs C/C++ format handlers on untrusted input. To parse untrusted archives inside the WebAssembly sandbox instead, set `smart-archive.sevenZBackend` to `wasm`.
- **Passwords on shared machines** — passwords are piped to native 7-Zip through stdin (`Enter password:` prompt), never passed as a command-line argument, so they do not appear in the process list. The WASM engine similarly keeps passwords inside the extension process.

## License

Proprietary. See [LICENSE](LICENSE).

## Acknowledgments

Thanks to everyone who contributed and the friendly community!
