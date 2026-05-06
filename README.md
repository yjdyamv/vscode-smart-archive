# Smart Archive

[![Version](https://img.shields.io/visual-studio-marketplace/v/yjdyamv.smart-archive)](https://marketplace.visualstudio.com/items?itemName=yjdyamv.smart-archive)
[![License](https://img.shields.io/github/license/yjdyamv/vscode-smart-archive)](LICENSE)

VSCode extension for compressing and decompressing files using **7-Zip WebAssembly** — no native binaries required.

## Features

- **Compress** to 7z, ZIP, TAR, WIM, GZip, BZip2, XZ, tar.gz, tar.bz2, tar.xz, tar.zst
- **Decompress** from 30+ formats: 7z, ZIP, RAR (v4/v5), TAR, GZ, BZ2, XZ, CAB, ISO, VHD, DEB, RPM, ...
- **AES-256 encryption** — password-protect 7z and ZIP archives
- **Archive browser** — opens as default editor for archives; virtual-scrolled tree (Vue 3 + TanStack Virtual), search, sort, partial extract, add/delete/rename, integrity test
- **File preview** — double-click any file in the archive to open it in VSCode
- **Copy/paste** — select files in archive browser, paste to any local folder
- **Multi-volume RAR** — auto-resolves `.r00`–`.r99` to the base `.rar`
- **RAR support** — RAR4 + RAR5 extraction via 7-Zip
- **Bilingual UI** — English / Chinese (auto-detected from VS Code locale)
- **Large file support** — handles archives and files exceeding 2 GiB via chunked I/O
- **Security** — Zip Slip protection, zip bomb size limits, path traversal blocking
- **Smart exclude** — automatically skips `node_modules`, `.git`, `dist`, `.venv`, and 30+ other noisy directories when compressing; customizable via settings
- **CJK filenames** — recovers GBK / Shift-JIS / EUC-KR encoded filenames in old archives
- **Context menu** — right-click files/folders to compress, right-click archives to decompress or browse

## Quick Start

```bash
npm install               # installs root + webview-ui deps (postinstall hook)
npm run build:webview     # build Vue frontend
npm run compile           # compile TypeScript
```

Then press `F5` in VSCode to launch the Extension Development Host.

## Usage

| Action | How |
|--------|-----|
| Compress | Right-click file(s)/folder(s) → `Smart Archive: Compress` → pick format → optional password → save |
| Decompress | Right-click archive → `Smart Archive: Decompress` → optional password → extracts to `*.extracted/` |
| Browse | Right-click archive → `Smart Archive: Browse Contents` → interactive file tree with partial extract |

RAR files are auto-detected and processed by 7-Zip WASM.

## Supported Formats

### Compression (create)

| Format | Encryption | Notes |
|--------|------------|-------|
| 7z | AES-256 | Best ratio, solid archive, header encryption |
| zip | AES-256 | Universal compatibility |
| tar | — | No compression, archive only |
| tar.gz | — | TAR + GZip compressed archive |
| tar.bz2 | — | TAR + BZip2 compressed archive |
| tar.xz | — | TAR + XZ compressed archive |
| tar.zst | — | TAR + Zstandard compressed archive |
| gz | — | Single-file GZip (auto-wraps in tar for folders) |
| bz2 | — | Single-file BZip2 (auto-wraps in tar for folders) |
| xz | — | Single-file XZ (auto-wraps in tar for folders) |
| wim | — | Windows Imaging Format |
| rar | — | **Extraction only** — creation not supported by free tools |

### Decompression (extract)

7z · ZIP · RAR (v4/v5) · TAR · GZ · BZ2 · XZ · Z · CAB · ARJ · LZH · CHM · MSI · WIM · CPIO · RPM · DEB · UHA · XAR · ISO · VHD · VMDK · FAT · NTFS · SquashFS · DMG · HFS · APM · MBR · ELF · Mach-O · SWF · FLV

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `smart-archive.defaultFormat` | `7z` | Default archive format (7z, zip, tar, tar.gz, tar.bz2, tar.xz, tar.zst, wim) |
| `smart-archive.defaultCompressionLevel` | `5` | Compression level (0=store, 5=normal, 9=ultra) |
| `smart-archive.defaultOutputDir` | `source` | Output location: `source` (next to archive) or `prompt` (always ask) |
| `smart-archive.maxFileSizeMiB` | `1024` | Maximum single decompressed file size (MiB) |
| `smart-archive.maxTotalSizeMiB` | `10240` | Maximum total decompressed size across all files (MiB) |
| `smart-archive.collapsedDirPatterns` | `[30+ patterns]` | Directory name patterns kept collapsed by default in archive preview |
| `smart-archive.compressExcludePatterns` | `[30+ patterns]` | Glob patterns for files/dirs to exclude when compressing |
| `smart-archive.defaultVolumeSize` | `""` | Default split volume size (e.g. `100m`, `1g`). Leave empty to skip. |

## Requirements

- VS Code 1.85.0 or later
- Node.js 20+ (for development)

## Development

```bash
npm install              # installs root + webview-ui deps (postinstall hook)
npm run build:webview    # build Vue frontend → media/vue/
npm run compile          # compile TypeScript → out/
npm run build            # build webview + compile (one step)
npm run watch            # watch mode (TS only)
npm run dev:webview      # Vite dev server with HMR for webview
npm run lint             # oxlint static analysis
npm run typecheck        # TypeScript type checking
npm run format           # oxfmt code formatting
npm run check            # format + lint + typecheck
npm run test             # vitest (extension + webview-ui)
npm run test:watch       # vitest watch mode
npm run test:ui          # vitest UI mode
npm run clean            # remove build output
npm run package          # create .vsix
npm run release          # build + check + package
```

Press `F5` in VS Code to launch the Extension Development Host. The webview must be built first (`npm run build:webview`).

## Dependencies

| Package | Purpose |
|---------|---------|
| [js7z-tools](https://github.com/GMH-Code/JS7z) | 7-Zip 25.01 WebAssembly port (all compression & extraction) |
| [@bokuweb/zstd-wasm](https://github.com/bokuweb/zstd-wasm) | Zstandard compression |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | CJK filename encoding fix |
| [Vue 3](https://vuejs.org/) | Archive browser UI |
| [TanStack Virtual](https://tanstack.com/virtual) | Virtual scrolling for large archives |

## License

MIT

## Acknowledgments

Thanks to everyone who contributed and the friendly community!
