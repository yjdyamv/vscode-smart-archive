/**
 * Oversized preview tests — Smart Archiver VSCode Extension
 *
 * Entries larger than MAX_PREVIEW_FILE_SIZE must reject with the
 * PreviewTooLargeError sentinel — the host preview path uses it to skip
 * the wasteful WASM fallback (which would hit the identical limit after
 * another full decompression).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { previewFileCore } from "../src/engines/modify-core";
import { PreviewTooLargeError } from "../src/utils/errors";
import { createWrapped } from "./helpers";
import { tmpDir } from "./tmp";

const OVERSIZE_BYTES = 105 * 1024 * 1024;

describe("previewFileCore oversize", () => {
  it("rejects an entry over the preview limit with PreviewTooLargeError", async () => {
    const td = tmpDir("sat_oversize_");
    // Repeated bytes compress to almost nothing on disk, but decompress to
    // 105MB — above MAX_PREVIEW_FILE_SIZE (100MB).
    const big = Buffer.alloc(OVERSIZE_BYTES, 0xab).toString("binary");
    const buf = await createWrapped({ "/big.bin": big }, "tar.gz");
    const archive = path.join(td, "wrapped.tar.gz");
    fs.writeFileSync(archive, Buffer.from(buf));
    const outPath = path.join(td, "preview.bin");

    await expect(previewFileCore(archive, "big.bin", undefined, outPath)).rejects.toBeInstanceOf(
      PreviewTooLargeError,
    );
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("previews a small entry normally and writes the output", async () => {
    const td = tmpDir("sat_smallpreview_");
    const buf = await createWrapped({ "/small.txt": "hello preview\n" }, "tar.gz");
    const archive = path.join(td, "wrapped.tar.gz");
    fs.writeFileSync(archive, Buffer.from(buf));
    const outPath = path.join(td, "preview.txt");

    await previewFileCore(archive, "small.txt", undefined, outPath);
    expect(fs.readFileSync(outPath, "utf8")).toBe("hello preview\n");
  });
});
