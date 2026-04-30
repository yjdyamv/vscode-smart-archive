# Smart Archive

VSCode extension for compressing and decompressing files using **7-Zip WebAssembly** and **libarchive WebAssembly** — no native binaries required.

## Features

- **Compress** to 7z, ZIP, TAR, WIM, GZip, BZip2, XZ, tar.gz, tar.bz2, tar.xz, tar.zst
- **Decompress** from 30+ formats: 7z, ZIP, RAR (v4/v5), TAR, GZ, BZ2, XZ, CAB, ISO, VHD, DEB, RPM, ...
- **AES-256 encryption** — password-protect 7z and ZIP archives
- **Archive browser** — opens as default editor for archives, tree view with search, sort, partial extract, delete, test
- **File preview** — double-click any file in the archive to open it in VSCode
- **In-place editing** — delete files from within archives (`7z d`)
- **Copy/paste** — select files in archive browser, paste to any local folder
- **Integrity test** — verify archives with `7z t`
- **Multi-volume RAR** — auto-resolves `.r00`–`.r99` to the base `.rar`
- **RAR support** — `libarchive-wasm` handles RAR extraction (RAR4 + RAR5)
- **Bilingual UI** — English / Chinese (auto-detected from VS Code locale)
- **Security** — Zip Slip protection, zip bomb size limits, path traversal blocking
- **CJK filenames** — recovers GBK / Shift-JIS / EUC-KR encoded filenames in old archives
- **Context menu** — right-click files/folders to compress, right-click archives to decompress or browse

## Quick Start

```bash
npm install
npm run compile   # build TypeScript
```

Then press `F5` in VSCode to launch the Extension Development Host.

## Usage

| Action | How |
|--------|-----|
| Compress | Right-click file(s)/folder(s) → `Smart Archive: Compress` → pick format → optional password → save |
| Decompress | Right-click archive → `Smart Archive: Decompress` → optional password → extracts to `*.extracted/` |
| Browse | Right-click archive → `Smart Archive: Browse Contents` → interactive file tree with partial extract |

RAR files are auto-detected and processed by `libarchive-wasm`. All other formats go through `js7z-tools` (7-Zip WASM) with automatic libarchive fallback.

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
| `smart-archive.defaultFormat` | `7z` | Default archive format |
| `smart-archive.defaultCompressionLevel` | `5` | Compression level (0=store, 5=normal, 9=ultra) |
| `smart-archive.defaultOutputDir` | `source` | Output location: next to source file or prompt |

## Development

```bash
npm install          # install dependencies
npm run compile      # compile TypeScript → out/
npm run watch        # watch mode
npm test             # compile + run 82 tests
npm run lint         # oxlint static analysis
npm run typecheck    # TypeScript type checking
npm run format       # oxfmt code formatting
npm run check        # format + lint + typecheck (CI)
npm run package      # compile + create VSIX package
```

## Testing

`npm test` runs 82 automated tests across two test suites:

- **core.test.ts** — 7z/ZIP/TAR/WIM/GZip/BZip2/XZ round-trips, encryption, cross-engine extraction, path traversal protection, zip bomb limits, CJK filename preservation
- **preview.test.ts** — Selective extraction (7z & libarchive) for all format variants, encrypted archives, two-step wrapped extraction, zstd round-trip

## Dependencies

| Package | Purpose |
|---------|---------|
| [js7z-tools](https://github.com/GMH-Code/JS7z) | 7-Zip 25.01 WebAssembly port |
| [libarchive-wasm](https://github.com/ofk/libarchive-wasm) | libarchive WebAssembly port (RAR support) |
| [@bokuweb/zstd-wasm](https://github.com/bokuweb/zstd-wasm) | Zstandard compression |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | CJK filename encoding fix |
| [pino](https://github.com/pinojs/pino) | Structured logging |

## License

MIT
