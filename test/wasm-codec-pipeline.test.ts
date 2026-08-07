/**
 * 7zz-wasm full-pipeline tests — Smart Archive VSCode Extension
 *
 * Forces the codec engines onto the bundled 7zz WASM engine and runs the
 * complete wrapped-format workflow for tar.zst / tar.lz4 / tar.br:
 * compress → list → rename → add → preview → delete → decompress.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compressWith7z as compressCore } from "../src/engines/js7z-compress-core";
import { decompressWith7z as decompressCore } from "../src/engines/js7z-decompress-core";
import { fetchFileListCore } from "../src/engines/fileListing-core";
import {
  addToArchiveCore,
  deleteFromArchiveCore,
  previewFileCore,
  renameInArchiveCore,
} from "../src/engines/modify-core";
import { setForceWasmCodec } from "../src/engines/js7z-codec";
import { tmpDir } from "./tmp";

function readDirRecursive(dir: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, readDirRecursive(full, key));
    } else if (entry.isFile()) {
      result[key] = fs.readFileSync(full, "utf-8");
    }
  }
  return result;
}

describe("7zz-wasm wrapped-format pipeline", () => {
  const formats = ["tar.zst", "tar.lz4", "tar.br"] as const;

  beforeAll(() => {
    setForceWasmCodec(true);
  });

  afterAll(() => {
    setForceWasmCodec(false);
  });

  for (const format of formats) {
    it(`${format}: compress → list → modify → preview → decompress`, async () => {
      const tdir = tmpDir(`sat_wasmpipe_${format.replace(".", "")}_`);
      try {
        const pkgDir = path.join(tdir, "pkg");
        fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
        fs.writeFileSync(path.join(pkgDir, "src", "main.ts"), "export const x = 1;");
        fs.writeFileSync(path.join(pkgDir, "readme.txt"), "readme content");

        const archivePath = path.join(tdir, `bundle.${format}`);
        await compressCore(
          {
            targets: [{ fsPath: pkgDir }],
            format: {
              label: format,
              description: "",
              canCreate: true,
              supportsEncryption: false,
            },
            outputPath: archivePath,
            password: "",
            level: 5,
          },
          undefined,
          undefined,
          [],
        );
        expect(fs.statSync(archivePath).size).toBeGreaterThan(0);

        const listed = await fetchFileListCore(archivePath);
        const listedPaths = listed.map((e) => e.path);
        expect(listedPaths).toContain("pkg/readme.txt");
        expect(listedPaths).toContain("pkg/src/main.ts");

        await renameInArchiveCore(archivePath, "pkg/readme.txt", "pkg/renamed.txt");
        const afterRename = (await fetchFileListCore(archivePath)).map((e) => e.path);
        expect(afterRename).toContain("pkg/renamed.txt");
        expect(afterRename).not.toContain("pkg/readme.txt");

        const addedPath = path.join(tdir, "added.txt");
        fs.writeFileSync(addedPath, "added content");
        await addToArchiveCore(archivePath, [addedPath], "pkg");
        const afterAdd = (await fetchFileListCore(archivePath)).map((e) => e.path);
        expect(afterAdd).toContain("pkg/added.txt");

        const previewPath = path.join(tdir, "preview.txt");
        await previewFileCore(archivePath, "pkg/renamed.txt", undefined, previewPath);
        expect(fs.readFileSync(previewPath, "utf-8")).toBe("readme content");

        await deleteFromArchiveCore(archivePath, ["pkg/renamed.txt"]);
        const afterDelete = (await fetchFileListCore(archivePath)).map((e) => e.path);
        expect(afterDelete).not.toContain("pkg/renamed.txt");
        expect(afterDelete).toContain("pkg/added.txt");

        const extractDir = path.join(tdir, "out");
        await decompressCore({ inputPath: archivePath, outputDir: extractDir, password: "" });
        const extracted = readDirRecursive(extractDir);
        expect(extracted["pkg/src/main.ts"]).toBe("export const x = 1;");
        expect(extracted["pkg/added.txt"]).toBe("added content");
        expect(extracted["pkg/renamed.txt"]).toBeUndefined();
      } finally {
        fs.rmSync(tdir, { recursive: true, force: true });
      }
    });
  }
});
