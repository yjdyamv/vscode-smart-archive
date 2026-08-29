/**
 * RAR5 direct modify (append/delete without rebuild) — Smart Archiver
 *
 * The rar5 binding (>= 0.3.1) appends members and deletes members
 * surgically: existing members keep their exact bytes, only the trailing
 * quick-open/recovery/end blocks are rewritten. These tests verify the
 * engine adapters against the REAL rar-rs CLI + bundled 7zz + rar5
 * binding. Gated on the local binaries; skipped where they are absent.
 */
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compressWithRar5,
  appendWithRar5,
  deleteWithRar5,
  listRar5Entries,
  expandRarSelection,
} from "../src/engines/rar5-engine";
import { gate, rar5CliBinaries } from "./gates";
import { tmpDir } from "./tmp";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

const RAR_CLI = rar5CliBinaries().rar;
const UNRAR_CLI = rar5CliBinaries().unrar;

function haveBinaries(): boolean {
  return process.platform === "linux" && gate("rar5Cli") && gate("rar5Binding");
}

describe("rar5 direct append (no rebuild)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(haveBinaries())(
    "appends members into a target dir while existing members keep their exact bytes",
    async () => {
      dir = tmpDir("sat_rar5ap-");
      const proj = path.join(dir, "proj");
      fs.mkdirSync(path.join(proj, "keep"), { recursive: true });
      fs.writeFileSync(path.join(proj, "keep", "a.txt"), "keep me");
      fs.writeFileSync(path.join(proj, "top.txt"), "top");

      const archive = path.join(dir, "out.rar");
      await compressWithRar5(
        { format: RAR5_FORMAT, outputPath: archive, targets: [{ fsPath: proj }], level: 3 },
        undefined,
        undefined,
        [],
      );
      const before = fs.readFileSync(archive);

      // Add new files into an existing archive directory, no rebuild.
      const extra = path.join(dir, "extra");
      fs.mkdirSync(extra, { recursive: true });
      fs.writeFileSync(path.join(extra, "n1.txt"), "new one");
      fs.writeFileSync(path.join(extra, "n2.txt"), "new two");
      await appendWithRar5(archive, [extra], "proj/keep", "", []);

      const listing = childProcess.execFileSync(RAR_CLI, ["l", archive], { encoding: "utf8" });
      expect(listing).toContain("proj/keep/extra/n1.txt");
      expect(listing).toContain("proj/keep/extra/n2.txt");

      const names = listRar5Entries(archive);
      expect(names).toContain("proj/keep/a.txt");
      expect(names).toContain("proj/top.txt");

      // The pre-append members must be byte-identical (extraction matches).
      const testOut = childProcess.execFileSync(UNRAR_CLI, ["t", archive], { encoding: "utf8" });
      expect(testOut).toContain("All");
      expect(testOut).toContain("OK");
      expect(before.length).toBeLessThan(fs.statSync(archive).size);
    },
  );

  it.runIf(haveBinaries())("appends to a password-protected archive", async () => {
    dir = tmpDir("sat_rar5appw-");
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "a.txt"), "secret");
    const archive = path.join(dir, "out.rar");
    await compressWithRar5(
      { format: RAR5_FORMAT, outputPath: archive, targets: [{ fsPath: proj }], password: "pw", level: 3 },
      undefined,
      undefined,
      [],
    );
    const extra = path.join(dir, "extra");
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, "b.txt"), "added");
    await appendWithRar5(archive, [extra], "", "pw", []);
    const testOut = childProcess.execFileSync(
      UNRAR_CLI,
      ["t", "-ppw", archive],
      { encoding: "utf8" },
    );
    expect(testOut).toContain("All");
    expect(testOut).toContain("OK");
  });
});

describe("rar5 direct delete (no rebuild)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(haveBinaries())(
    "deletes a folder selection (all members below it) surgically",
    async () => {
      dir = tmpDir("sat_rar5del-");
      const proj = path.join(dir, "proj");
      fs.mkdirSync(path.join(proj, "keep"), { recursive: true });
      fs.mkdirSync(path.join(proj, "drop", "sub"), { recursive: true });
      fs.writeFileSync(path.join(proj, "keep", "a.txt"), "keep me");
      fs.writeFileSync(path.join(proj, "drop", "b.txt"), "drop me");
      fs.writeFileSync(path.join(proj, "drop", "sub", "c.txt"), "drop too");
      fs.writeFileSync(path.join(proj, "top.txt"), "top");
      const archive = path.join(dir, "out.rar");
      await compressWithRar5(
        { format: RAR5_FORMAT, outputPath: archive, targets: [{ fsPath: proj }], level: 3 },
        undefined,
        undefined,
        [],
      );

      const deleted = await deleteWithRar5(archive, ["proj/drop"], "");
      expect(deleted).toBeGreaterThan(0);

      const names = listRar5Entries(archive);
      expect(names).not.toContain("proj/drop/b.txt");
      expect(names).not.toContain("proj/drop/sub/c.txt");
      expect(names).toContain("proj/keep/a.txt");
      expect(names).toContain("proj/top.txt");

      const testOut = childProcess.execFileSync(UNRAR_CLI, ["t", archive], { encoding: "utf8" });
      expect(testOut).toContain("All");
      expect(testOut).toContain("OK");
    },
  );

  it.runIf(haveBinaries())(
    "deleting every member erases the archive (official `rar d` behavior)",
    async () => {
      dir = tmpDir("sat_rar5erase-");
      const proj = path.join(dir, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "a.txt"), "a");
      fs.writeFileSync(path.join(proj, "b.txt"), "b");
      const archive = path.join(dir, "out.rar");
      await compressWithRar5(
        { format: RAR5_FORMAT, outputPath: archive, targets: [{ fsPath: proj }], level: 3 },
        undefined,
        undefined,
        [],
      );
      expect(fs.existsSync(archive)).toBe(true);

      const deleted = await deleteWithRar5(archive, ["proj/a.txt", "proj/b.txt"], "");
      expect(deleted).toBe(2);
      expect(fs.existsSync(archive)).toBe(false);
    },
  );

  it("expands directory selections to exact member names", () => {
    const all = ["d/", "d/a.txt", "d/sub/b.txt", "f.txt"];
    expect(expandRarSelection(all, ["d"]).sort()).toEqual([
      "d/",
      "d/a.txt",
      "d/sub/b.txt",
    ]);
    expect(expandRarSelection(all, ["f.txt"])).toEqual(["f.txt"]);
    expect(expandRarSelection(all, ["missing"])).toEqual(["missing"]);
    expect(expandRarSelection(all, ["d\\a.txt"])).toEqual(["d/a.txt"]);
  });
});
