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

## Packaging

Node 24 (what CI uses); `npm ci` in the repo root also installs `webview-ui`. Both commands below restore `.vscodeignore` when they finish.

- `npm run package:cross` — one universal `.vsix` bundling every platform's native 7zz/rar5/snappy binaries (~27 MB). This is what CI builds and attaches to each GitHub release.
- `npm run package:targets` — one `.vsix` per VS Code target (`win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`), each keeping only its own native binaries (~6-9 MB; `darwin-x64` is WASM-only). Append target names to build a subset: `node scripts/package-target.mjs win32-x64 darwin-arm64`.

Target builds are not wired into CI: a platform-trimmed package only saves download size if the Marketplace carries a variant for that same version, and the Marketplace has no scriptable publish path without an Azure DevOps token. The universal package stays the fallback for every platform that has no variant.

## Contributing

Bug reports and pull requests are welcome. Contributions are accepted under
the project license via the [CLA](CLA.md); human contributors sign their own
commits (see [AGENTS.md](AGENTS.md) for the trailer rules).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Bundled
libraries and binaries keep their own licenses (see
[ThirdPartyNotices.md](ThirdPartyNotices.md)); in particular the 7-Zip ZS
builds are LGPL-2.1+ with the unRAR restriction, and their source is published
at [yjdyamv/7-Zip-zstd-native](https://github.com/yjdyamv/7-Zip-zstd-native)
and [yjdyamv/7-Zip-zstd-wasm](https://github.com/yjdyamv/7-Zip-zstd-wasm).

Versions published before this change (up to and including 2.7.1) remain under
the license they shipped with; the terms above apply from the next release on.

This is an independent project, unaffiliated with any similarly named product;
only builds published from this repository are official releases.
