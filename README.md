# Smart Archiver

[![Build](https://github.com/yjdyamv/vscode-smart-archive/actions/workflows/build.yml/badge.svg)](https://github.com/yjdyamv/vscode-smart-archive/actions/workflows/build.yml)

Create, extract, and browse archives in VS Code — powered by a **bundled native 7-Zip** (WASM fallback) plus native **zstd/lz4/brotli** codecs. Works out of the box, nothing to install.

> RAR and WinRAR are registered trademarks of RARLAB; this extension is not affiliated with or endorsed by RARLAB.
>
> Renamed from `smart-archive` → ships as `yjdyamv.smart-archiver`: re-apply settings (now `smart-archiver.*`) and keybindings (command IDs now `yjdyamv.smart-archiver.*`).

## Features

- **Compress** to 7z, ZIP, RAR5, TAR, WIM, tar.gz/bz2/xz/zst/lz4/br/sz — **extract** 40+ formats (everything 7-Zip reads)
- **AES-256 encryption** for 7z/zip/rar5 (header encryption, recovery records)
- **Archive browser** — search, multi-select, add/delete/rename in place, preview, copy/paste
- **Multi-volume** — RAR `.r00`/`.partN`, split 7z/zip `.001`
- **Big files** — archives beyond 2 GiB
- **Secure** — zip-slip, size-limit, and decompression-bomb protection
- **Smart exclude** (skips `node_modules`, `.git`, …); **GBK filename recovery** for old CJK archives
- **Trilingual UI** — English / 简体中文 / 繁體中文; right-click anywhere

## Usage

| Action | How |
| --- | --- |
| Compress | Right-click file(s)/folder(s) → `Smart Archiver: Compress` → format → optional password |
| Extract | Right-click archive → `Smart Archiver: Extract` → extracts to `<name>.extracted/` |
| Extract to… | Right-click archive → pick a folder (opt-in: `smart-archiver.extractTo.enabled`) |
| Browse | Right-click archive → `Smart Archiver: Browse Contents`, or double-click it |

Browser keys: `↑↓`/`PgUp`/`PgDn`/`Home`/`End` move · `Space` toggle · `Enter` extract · `Delete` remove · `F2` rename · `Ctrl+A` select all · `Ctrl+C` copy · `Esc` clear.

## License

Proprietary. See [LICENSE](LICENSE).
