/**
 * Selective-extraction unit tests — Smart Archive VSCode Extension
 *
 * extractSelectedCore, both branches:
 *   - wrapped (tar.gz / tar.zst / tar.lz4 / tar.br / tar.sz): outer layer →
 *     inner tar → selected paths
 *   - plain (7z): single-step extraction
 *
 * Regressions: the inner tar was read from the VFS root instead of the
 * outer-extraction scratch dir (FS.ErrnoError 44, mangled to
 * "[object Object]" at the worker boundary), and the codec-based wrapped
 * formats (lz4/br/sz) stage the inner tar at the VFS root — both branches
 * must read from where they wrote.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { extractSelectedCore } from "../src/engines/extract-core";
import { createWrapped, j7zCompressDir } from "./helpers";
import { tmpDir } from "./tmp";

const FILES = {
  "pkg/a.txt": "hello a\n",
  "pkg/sub/b.txt": "hello b\n",
  "pkg/sub/c.txt": "hello c\n",
};

async function buildWrappedArchive(dir: string, ext: string, files = FILES): Promise<string> {
  const buf = await createWrapped(files, ext);
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
  for (const ext of ["tar.gz", "tar.zst", "tar.lz4", "tar.br", "tar.sz"] as const) {
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

  it("applies excludes to the inner extraction", async () => {
    const td = tmpDir("sat_ext_excl_");
    const archive = await buildWrappedArchive(td, "tar.gz", {
      ...FILES,
      "pkg/sub/x.log": "noise\n",
    });
    const out = path.join(td, "out");

    await extractSelectedCore(archive, ["pkg"], undefined, false, out, ["*.log"]);

    const files = collectFiles(out);
    expect(files.get("pkg/a.txt")).toBe("hello a\n");
    expect(files.get("pkg/sub/b.txt")).toBe("hello b\n");
    expect(files.has("pkg/sub/x.log")).toBe(false);
  });

  it("falls back to a full extraction when the selection matches nothing", async () => {
    const td = tmpDir("sat_ext_fallback_");
    const archive = await buildWrappedArchive(td, "tar.gz");
    const out = path.join(td, "out");

    await extractSelectedCore(archive, ["pkg/ghost"], undefined, false, out, undefined);

    // Nothing matched the selection, so no prefix strip applies — the whole
    // tree is preserved with its original paths.
    const files = collectFiles(out);
    expect(files.get("pkg/a.txt")).toBe("hello a\n");
    expect(files.get("pkg/sub/b.txt")).toBe("hello b\n");
    expect(files.get("pkg/sub/c.txt")).toBe("hello c\n");
  });

  it("renames colliding outputs with a _N suffix", async () => {
    const td = tmpDir("sat_ext_collision_");
    const archive = await buildWrappedArchive(td, "tar.gz");
    const out = path.join(td, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "a.txt"), "OLD");

    await extractSelectedCore(archive, ["pkg/a.txt"], undefined, false, out, undefined);

    const files = collectFiles(out);
    expect(files.get("a.txt")).toBe("OLD");
    expect(files.get("a_2.txt")).toBe("hello a\n");
  });

  it("skips .smartarchive marker entries", async () => {
    const td = tmpDir("sat_ext_marker_");
    const archive = await buildWrappedArchive(td, "tar.gz", {
      ...FILES,
      "/.smartarchive": "\u0000",
    });
    const out = path.join(td, "out");

    await extractSelectedCore(archive, ["pkg"], undefined, false, out, undefined);

    const files = collectFiles(out);
    expect(files.has(".smartarchive")).toBe(false);
    expect(files.get("pkg/a.txt")).toBe("hello a\n");
  });
});

describe("extractSelectedCore non-wrapped", () => {
  async function buildPlainArchive(dir: string): Promise<string> {
    const buf = await j7zCompressDir(
      { "/pkg/a.txt": "hello a\n", "/pkg/sub/b.txt": "hello b\n", "/pkg/sub/c.txt": "hello c\n" },
      "/x.7z",
    );
    const archive = path.join(dir, "x.7z");
    fs.writeFileSync(archive, Buffer.from(buf));
    return archive;
  }

  it("extracts selected paths from .7z", async () => {
    const td = tmpDir("sat_ext_7z_");
    const archive = await buildPlainArchive(td);
    const out = path.join(td, "out");

    await extractSelectedCore(archive, ["pkg/a.txt", "pkg/sub"], undefined, false, out, undefined);

    const files = collectFiles(out);
    expect(files.size).toBe(3);
    expect(files.get("a.txt")).toBe("hello a\n");
    expect(files.get("sub/b.txt")).toBe("hello b\n");
    expect(files.get("sub/c.txt")).toBe("hello c\n");
  });

  it("extracts flat from .7z", async () => {
    const td = tmpDir("sat_ext_7z_flat_");
    const archive = await buildPlainArchive(td);
    const out = path.join(td, "out");

    await extractSelectedCore(archive, ["pkg/a.txt", "pkg/sub/b.txt"], undefined, true, out, undefined);

    const files = collectFiles(out);
    expect(files.get("a.txt")).toBe("hello a\n");
    expect(files.get("b.txt")).toBe("hello b\n");
  });

  it("renames colliding outputs with a _N suffix", async () => {
    const td = tmpDir("sat_ext_7z_collision_");
    const archive = await buildPlainArchive(td);
    const out = path.join(td, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "a.txt"), "OLD");

    await extractSelectedCore(archive, ["pkg/a.txt"], undefined, false, out, undefined);

    const files = collectFiles(out);
    expect(files.get("a.txt")).toBe("OLD");
    expect(files.get("a_2.txt")).toBe("hello a\n");
  });
});
