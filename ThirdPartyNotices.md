# Third Party Notices

Smart Archive uses the following third-party libraries, each under its own license.

## Native Modules (distributed as separate binaries)

| Package | License | Source |
|---------|---------|--------|
| @vscode/codicons | CC-BY-4.0 | https://github.com/microsoft/vscode-codicons |
| 7-Zip ZS (7zz-wasm, vendor/7zz-wasm/) | LGPL-2.1+ (7-Zip) | https://github.com/yjdyamv/7-Zip-zstd-wasm |
| lz4-napi | MIT | https://github.com/yjdyamv/lz4-napi |
| zstd-napi | Apache-2.0 | https://github.com/yjdyamv/zstd-napi |
| 7-Zip (7zz / 7z.exe + 7z.dll, bundled under 7z-bin/) | LGPL-2.1+ with unRAR restriction | https://github.com/ip7z/7zip |

The bundled 7-Zip console binaries are unmodified official builds, invoked as a
separate process. The RAR extraction code is subject to the unRAR license (it may
not be used to develop a RAR-compatible archiver); the extension only invokes 7-Zip
for extraction. See the 7-Zip License.txt shipped alongside the binaries.

## Bundled Dependencies (inlined into extension.js)

| Package | License | Source |
|---------|---------|--------|
| iconv-lite | MIT | https://github.com/ashtuchkin/iconv-lite |
| minimatch | BlueOak-1.0.0 | https://github.com/isaacs/minimatch |
| pino | MIT | https://github.com/pinojs/pino |
