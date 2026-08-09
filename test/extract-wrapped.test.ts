/**
 * Wrapped-format extraction unit tests — Smart Archive VSCode Extension
 *
 * extractSelectedCore's wrapped branch: outer layer → inner tar → selected
 * paths. Regression: the inner tar was read from the VFS root instead of
 * the outer-extraction scratch dir (FS.ErrnoError 44, mangled to
 * "[object Object]" at the worker boundary).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { extractSelectedCore } from "../src/engines/extract-core";
import { createWrapped } from "./helpers";
import { tmpDir } from "./tmp";

const FILES = {
  "pkg/a.txt": "hello a\n",
  "pkg/sub/b.txt": "hello b\n",
  "pkg/sub/c.txt": "hello c\n",
};

async function buildWrappedArchive(dir: string, ext: string): Promise<string> {
  const buf = await createWrapped(FILES, ext);
  const archive = path.join(dir, `wrapped.${ext}`);
  fs.writeFileSync(archive, Buffer.from(buf));
  return archive;
}

function collectFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join("/"), fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

describe("extractSelectedCore wrapped", () => {
  for (const ext of ["tar.gz", "tar.zst"] as const) {
    it(`extracts selected paths from .${ext}`, async () => {
      const td = tmpDir(`sat_ext_${ext.replace(".", "_")}_`);
      const archive = await buildWrappedArchive(td, ext);
      const out = path.join(td, "out");

      await extractSelectedCore(
        archive,
        ["pkg/a.txt", "pkg/sub"],
        undefined,
        false,
        out,
        undefined,
      );

      const files = collectFiles(out);
      expect(files.size).toBe(3);
      expect(files.get("a.txt")).toBe("hello a\n");
      expect(files.get("sub/b.txt")).toBe("hello b\n");
      expect(files.get("sub/c.txt")).toBe("hello c\n");
    });
  }

  it("extracts flat (no directory structure) when requested", async () => {
    const td = tmpDir("sat_ext_flat_");
    const archive = await buildWrappedArchive(td, "tar.gz");
    const out = path.join(td, "out");

    await extractSelectedCore(archive, ["pkg/a.txt", "pkg/sub/b.txt"], undefined, true, out, undefined);

    const files = collectFiles(out);
    expect(files.get("a.txt")).toBe("hello a\n");
    expect(files.get("b.txt")).toBe("hello b\n");
  });
});
