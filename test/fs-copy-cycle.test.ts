/**
 * WASM copy-path cycle guards — Smart Archiver VSCode Extension
 *
 * Regression: copyDirToFS / sumTreeBytes followed circular junctions until
 * the OS path limit. They now carry the same realpath cycle guard as
 * collectTarPaths: an ancestor directory is entered once, broken links are
 * skipped, and symlinked directory contents are stored (dereferenced).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { copyDirToFS, sumTreeBytes } from "../src/utils/fs";
import { logger } from "../src/utils/logger-core";
import type { JS7zInstance } from "../src/types";
import { tmpDir } from "./tmp";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function mkJunction(root: string, link: string, target: string): void {
  execSync(`cmd /c mklink /J "${link}" "${target}"`);
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

describe("WASM copy-path cycle guards", () => {
  it.runIf(process.platform === "win32")(
    "copyDirToFS follows a directory junction and stores its contents",
    () => {
      const td = tmpDir("sat_fscopy_");
      dirs.push(td);
      const proj = path.join(td, "proj");
      const agent = path.join(proj, ".agent");
      fs.mkdirSync(agent, { recursive: true });
      fs.writeFileSync(path.join(agent, "config.json"), '{"a":1}');
      mkJunction(proj, path.join(proj, ".claude"), agent);

      const written = new Map<string, string>();
      const copied = copyDirToFS(mockJs7z(written), proj, "/in/proj");

      expect(written.get("/in/proj/.claude/config.json")).toBe('{"a":1}');
      expect(copied).toBe('{"a":1}'.length);
    },
  );

  it.runIf(process.platform === "win32")(
    "copyDirToFS enters a circular junction only once",
    () => {
      const td = tmpDir("sat_fscopy2_");
      dirs.push(td);
      const proj = path.join(td, "proj");
      const a = path.join(proj, "a");
      fs.mkdirSync(a, { recursive: true });
      fs.writeFileSync(path.join(a, "file.txt"), "hello");
      mkJunction(a, path.join(a, "loop"), proj);

      const written = new Map<string, string>();
      const copied = copyDirToFS(mockJs7z(written), proj, "/in/proj");

      expect(written.get("/in/proj/a/file.txt")).toBe("hello");
      expect(copied).toBe("hello".length);
      expect([...written.keys()].filter((k) => k.includes("loop"))).toHaveLength(0);
    },
  );

  it.runIf(process.platform === "win32")(
    "sumTreeBytes counts junction contents and stops at a cycle",
    () => {
      const td = tmpDir("sat_fscopy3_");
      dirs.push(td);
      const proj = path.join(td, "proj");
      const agent = path.join(proj, ".agent");
      fs.mkdirSync(agent, { recursive: true });
      fs.writeFileSync(path.join(agent, "config.json"), '{"a":1}');
      fs.writeFileSync(path.join(proj, "readme.md"), "hi");
      mkJunction(proj, path.join(proj, ".claude"), agent);
      mkJunction(proj, path.join(proj, "loop"), proj);

      const total = sumTreeBytes([proj]);
      expect(total).toBe('{"a":1}'.length + "hi".length);
    },
  );

  it.runIf(process.platform === "win32")(
    "sumTreeBytes stops at a multi-node junction ring",
    () => {
      const td = tmpDir("sat_fscopy4_");
      dirs.push(td);
      const a = path.join(td, "a");
      const b = path.join(td, "b");
      const c = path.join(td, "c");
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      fs.mkdirSync(c, { recursive: true });
      fs.writeFileSync(path.join(a, "file.txt"), "A");
      fs.writeFileSync(path.join(b, "file.txt"), "B");
      fs.writeFileSync(path.join(c, "file.txt"), "C");
      // Ring: a/loop → b, b/loop → c, c/loop → a.
      mkJunction(a, path.join(a, "loop"), b);
      mkJunction(b, path.join(b, "loop"), c);
      mkJunction(c, path.join(c, "loop"), a);

      const total = sumTreeBytes([a]);
      expect(total).toBe("A".length + "B".length + "C".length);
    },
  );

  it.runIf(process.platform === "win32")(
    "copyDirToFS enters each node of a multi-node junction ring once",
    () => {
      const td = tmpDir("sat_fscopy5_");
      dirs.push(td);
      const a = path.join(td, "a");
      const b = path.join(td, "b");
      const c = path.join(td, "c");
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      fs.mkdirSync(c, { recursive: true });
      fs.writeFileSync(path.join(a, "file.txt"), "A");
      fs.writeFileSync(path.join(b, "file.txt"), "B");
      fs.writeFileSync(path.join(c, "file.txt"), "C");
      mkJunction(a, path.join(a, "loop"), b);
      mkJunction(b, path.join(b, "loop"), c);
      mkJunction(c, path.join(c, "loop"), a);

      const written = new Map<string, string>();
      const copied = copyDirToFS(mockJs7z(written), a, "/in/a");

      expect(written.get("/in/a/file.txt")).toBe("A");
      expect(written.get("/in/a/loop/file.txt")).toBe("B");
      expect(written.get("/in/a/loop/loop/file.txt")).toBe("C");
      // The ring closes back on a — nothing beyond the three nodes.
      expect([...written.keys()]).toHaveLength(3);
      expect(copied).toBe(3);
    },
  );

  it.runIf(process.platform === "win32")(
    "copyDirToFS warns when a circular junction is skipped",
    () => {
      const td = tmpDir("sat_fscopy6_");
      dirs.push(td);
      const proj = path.join(td, "proj");
      const a = path.join(proj, "a");
      fs.mkdirSync(a, { recursive: true });
      fs.writeFileSync(path.join(a, "file.txt"), "hello");
      mkJunction(a, path.join(a, "loop"), proj);

      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        copyDirToFS(mockJs7z(new Map()), proj, "/in/proj");
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: "fs.copy.cycleSkip" }),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );
});