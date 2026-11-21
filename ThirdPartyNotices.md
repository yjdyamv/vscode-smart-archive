# Third Party Notices

Smart Archiver itself is licensed under Apache-2.0 (see [LICENSE](LICENSE) and
[NOTICE](NOTICE)); the components below keep their own licenses.

Smart Archiver uses the following third-party libraries, each under its own license.

## Native Modules (distributed as separate binaries)

All four are npm dependencies now; earlier releases staged them under
`vendor/` with download scripts, which is why old notices name paths.

| Package | License | Source |
| --------- | --------- | -------- |
| @vscode/codicons | CC-BY-4.0 | <https://github.com/microsoft/vscode-codicons> |
| 7-Zip ZS WASM (npm: 7zip-zstd-wasm) | LGPL-2.1+ with unRAR restriction | <https://github.com/yjdyamv/7-Zip-zstd-wasm> |
| 7-Zip ZS native (vendor/7z-bin/) | LGPL-2.1+ with unRAR restriction | <https://github.com/yjdyamv/7-Zip-zstd-native> |
| rar-rs (npm: @yjdyamv/rar-rs — native + WASI) | BSD-2-Clause | <https://github.com/yjdyamv/rar-rs> |

Both 7-Zip ZS builds are compiled from 7-Zip sources, whose license adds a
restriction (the "unRAR restriction") on the RAR decompression engine: that
code may not be used to develop a RAR (WinRAR) compatible archiver. Smart
Archiver honours it by scope — the 7-Zip binaries are only ever used to read
RAR archives, and archive creation goes through rar-rs, our own
implementation, which contains no unRAR-derived code.

## Bundled Dependencies (inlined into extension.js)

| Package | License | Source |
| --------- | --------- | -------- |
| iconv-lite | MIT | <https://github.com/ashtuchkin/iconv-lite> |
| minimatch | BlueOak-1.0.0 | <https://github.com/isaacs/minimatch> |
| pino | MIT | <https://github.com/pinojs/pino> |
| node-tar | BlueOak-1.0.0 | <https://github.com/isaacs/node-tar> |
