/**
 * Manual folder-append e2e: adding folders (nested, empty, into a target
 * dir) to an existing RAR5 archive without rebuilding.
 *   npx vitest run test/tmp-folder-e2e.test.ts
 */
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  compressWithRar5,
  appendWithRar5,
  listRar5Entries,
} from "../src/engines/rar5-engine";
import { rar5CliBinaries, gate } from "./gates";
import { tmpDir } from "./tmp";

// Manual e2e: needs the rar-rs CLI plus the staged native binding (CI
// `check` stages neither); opt in on the dev machine where both exist.
const HAVE_BINARIES = gate("rar5Cli") && gate("rar5Binding");

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

const RAR_CLI = rar5CliBinaries().rar;

function run(bin: string, args: string[]): string {
  return childProcess.execFileSync(bin, args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

describe.runIf(HAVE_BINARIES)("folder append (manual)", () => {
  it("adds nested folders, empty folders and folders into a target dir", async () => {
    const dir = tmpDir("sat_fold-");
    try {
      const proj = path.join(dir, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "a.txt"), "alpha");
      const archive = path.join(dir, "out.rar");
      await compressWithRar5(
        { format: RAR5_FORMAT, outputPath: archive, targets: [{ fsPath: proj }], level: 3 },
        undefined,
        undefined,
        [],
      );

      // folder with nested subdirectories
      const docs = path.join(dir, "docs");
      fs.mkdirSync(path.join(docs, "sub", "deep"), { recursive: true });
      fs.writeFileSync(path.join(docs, "readme.md"), "hi");
      fs.writeFileSync(path.join(docs, "sub", "x.txt"), "x");
      fs.writeFileSync(path.join(docs, "sub", "deep", "y.txt"), "y");
      // empty folder (no children at all)
      const empty = path.join(dir, "emptyfolder");
      fs.mkdirSync(empty, { recursive: true });

      await appendWithRar5(archive, [docs, empty], "", "", []);
      let names = listRar5Entries(archive);
      expect(names).toContain("docs/");
      expect(names).toContain("docs/sub/");
      expect(names).toContain("docs/sub/deep/");
      expect(names).toContain("docs/sub/deep/y.txt");
      expect(names).toContain("emptyfolder/");

      // folder into a target dir
      const extra2 = path.join(dir, "extra2");
      fs.mkdirSync(extra2, { recursive: true });
      fs.writeFileSync(path.join(extra2, "z.txt"), "z");
      await appendWithRar5(archive, [extra2], "docs/sub", "", []);
      names = listRar5Entries(archive);
      expect(names).toContain("docs/sub/extra2/");
      expect(names).toContain("docs/sub/extra2/z.txt");

      const listOut = run(RAR_CLI, ["l", archive]);
      expect(listOut).toContain("docs/sub/deep/y.txt");
      expect(listOut).toContain("emptyfolder/");
      const tOut = run(RAR_CLI, ["t", archive]);
      expect(tOut).toContain("OK");
      console.log("[folder] nested+empty+targetdir append OK");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
