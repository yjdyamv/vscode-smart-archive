# Smart Archive

VSCode extension for compressing and decompressing files using **7-Zip WebAssembly** and **libarchive WebAssembly** — no native binaries required.

## Features

- **Compress** to 7z, ZIP, TAR, GZip, BZip2, XZ
- **Decompress** from 30+ formats: 7z, ZIP, RAR (v4/v5), TAR, GZ, BZ2, XZ, CAB, ISO, VHD, DEB, RPM, ...
- **AES-256 encryption** — password-protect 7z and ZIP archives
- **RAR support** — `libarchive-wasm` handles RAR extraction (RAR4 + RAR5)
- **Folder compression** — nested directories preserved in archive
- **Multi-select** — select multiple files/folders, compress into one archive
- **Context menu** — right-click any file or folder in VSCode Explorer

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

RAR files are auto-detected and processed by `libarchive-wasm`. All other formats go through `js7z-tools` (7-Zip WASM).

## Architecture

```
src/
├── extension.ts            # Entry point — registers commands
├── constants.ts            # Format lists, RAR detection regex
├── types/index.ts          # Shared TypeScript interfaces
├── commands/
│   ├── compress.ts         # Compress workflow (UI → engine)
│   └── decompress.ts       # Decompress workflow (auto-detect engine)
├── engines/
│   ├── js7z-engine.ts      # 7-Zip WASM wrapper (js7z-tools)
│   └── libarchive-engine.ts # libarchive WASM wrapper (RAR extraction)
├── ui/prompts.ts           # VSCode dialog wrappers
└── utils/
    ├── fs.ts               # Local ↔ virtual FS bidirectional sync
    └── path.ts             # Unix-style path helpers for virtual FS
```

## Supported Formats

### Compression (create)

| Format | Encryption | Notes |
|--------|------------|-------|
| 7z | AES-256 | Best ratio, solid archive, header encryption |
| zip | AES-256 | Universal compatibility |
| tar | — | No compression, archive only |
| gz | — | Single-file GZip |
| bz2 | — | Single-file BZip2 |
| xz | — | Single-file XZ (LZMA2) |
| rar | — | **Extraction only** — creation not supported by free tools |

### Decompression (extract)

7z · ZIP · RAR (v4/v5) · TAR · GZ · BZ2 · XZ · CAB · ARJ · LZH · CHM · MSI · WIM · CPIO · RPM · DEB · UHA · XAR · ISO · VHD · VMDK · FAT · NTFS · SquashFS · DMG · HFS · ELF · Mach-O · SWF · FLV

## Development

```bash
npm install          # install dependencies
npm run compile      # compile TypeScript → out/
npm run watch        # watch mode
npm test             # compile + run 15 tests
npm run lint         # type-check only (no output)
```

## Testing

`npm test` runs 15 automated tests:

- JS7z engine initialization
- 7z / ZIP / TAR / GZip / XZ round-trip compression+decompression
- Folder compression with nested directory preservation
- Mixed files+folders in single archive
- Full extension flow simulation (local FS → virtual FS → compress → verify)
- AES-256 encrypted 7z and ZIP round-trips
- Wrong password rejection
- libarchive-wasm cross-engine extraction (7z, ZIP, TAR, GZip, XZ, folder, encrypted)

## Dependencies

| Package | Purpose |
|---------|---------|
| [js7z-tools](https://github.com/GMH-Code/JS7z) | 7-Zip 25.01 WebAssembly port |
| [libarchive-wasm](https://github.com/ofk/libarchive-wasm) | libarchive WebAssembly port (RAR support) |

## License

MIT
