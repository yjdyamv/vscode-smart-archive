/**
 * Special-file (FIFO / socket / device) guards — Smart Archiver VSCode
 * Extension
 *
 * Reading a FIFO/socket/device as a regular file blocks forever, so every
 * compress-side walker must skip it. isSpecialEntry is the shared
 * classifier (exercised on every platform); walkers are exercised with
 * real FIFOs via mkfifo where the platform supports it (POSIX only —
 * Windows cannot create FIFOs).
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { copyDirToFS, sumTreeBytes } from "../src/utils/fs";
import { collectTarPaths } from "../src/engines/tar-writer";
import { isSpecialEntry } from "../src/utils/security";
import { prepareExclusions } from "../src/utils/exclude";
import { logger } from "../src/utils/logger-core";
import type { JS7zInstance } from "../src/types";
import { tmpDir } from "./tmp";

/** A fake dirent/stats of the given type (regular file by default). */
function fakeEntry(name: string, kind: string) {
  const special = (k: string) => k === kind;
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
    isFIFO: () => special("fifo"),
    isSocket: () => special("socket"),
    isBlockDevice: () => special("block"),
    isCharacterDevice: () => special("char"),
  };
}

/** Minimal virtual-FS stub: small files land in `written`, dirs are no-ops. */
function mockJs7z(written: Map<string, string>): JS7zInstance {
  return {
    FS: {
      mkdir: () => {},
      writeFile: (p: string, data: Uint8Array) => {
        written.set(p, Buffer.from(data).toString("utf8"));
      },
    },
  } as unknown as JS7zInstance;
}

describe("isSpecialEntry classification", () => {
  it("detects FIFOs, sockets and device files", () => {
    expect(isSpecialEntry(fakeEntry("p", "fifo"))).toBe(true);
    expect(isSpecialEntry(fakeEntry("s", "socket"))).toBe(true);
    expect(isSpecialEntry(fakeEntry("b", "block"))).toBe(true);
    expect(isSpecialEntry(fakeEntry("c", "char"))).toBe(true);
  });

  it("accepts regular files and directories", () => {
    expect(isSpecialEntry(fakeEntry("f", "file"))).toBe(false);
    expect(isSpecialEntry(fakeEntry("d", "directory"))).toBe(false);
  });

  it("works with real fs.Stats", () => {
    const st = fs.statSync(__filename);
    expect(isSpecialEntry(st)).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("walkers skip real FIFOs (POSIX)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function mkFifo(dir: string): string {
    const p = path.join(dir, "pipe");
    execSync(`mkfifo "${p}"`);
    return p;
  }

  it("copyDirToFS skips a FIFO entry and warns", () => {
    const td = tmpDir("sat_special_");
    dirs.push(td);
    const proj = path.join(td, "proj");
    fs.mkdirSync(proj, { recursive: true });
    mkFifo(proj);
    fs.writeFileSync(path.join(proj, "a.txt"), "hello");

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const written = new Map<string, string>();
    const copied = copyDirToFS(mockJs7z(written), proj, "/in/proj");

    expect(written.get("/in/proj/a.txt")).toBe("hello");
    expect([...written.keys()]).toHaveLength(1); // FIFO never copied
    expect(copied).toBe("hello".length);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "fs.copy.specialSkip" }));
  });

  it("collectTarPaths leaves a FIFO out of the walk and warns", () => {
    const td = tmpDir("sat_special2_");
    dirs.push(td);
    const proj = path.join(td, "proj");
    fs.mkdirSync(proj, { recursive: true });
    mkFifo(proj);

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const walk = collectTarPaths(proj, prepareExclusions([]));

    expect(walk.files).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tarWriter.specialSkip" }),
    );
  });

  it("sumTreeBytes counts nothing for a FIFO and warns", () => {
    const td = tmpDir("sat_special3_");
    dirs.push(td);
    const proj = path.join(td, "proj");
    fs.mkdirSync(proj, { recursive: true });
    mkFifo(proj);

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const total = sumTreeBytes([proj]);

    expect(total).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fs.sumTree.specialSkip" }),
    );
  });

  it("a symlink pointing at a FIFO is skipped by collectTarPaths", () => {
    const td = tmpDir("sat_special4_");
    dirs.push(td);
    const proj = path.join(td, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const fifo = mkFifo(proj);
    execSync(`ln -s "${fifo}" "${path.join(proj, "link")}"`);

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const walk = collectTarPaths(proj, prepareExclusions([]));

    expect(walk.files).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tarWriter.specialSkip" }),
    );
  });
});