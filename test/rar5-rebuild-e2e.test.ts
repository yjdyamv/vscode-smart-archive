/**
 * End-to-end RAR5 rebuild — Smart Archive
 *
 * Reproduces the webview "delete folder inside a RAR archive" flow with
 * the REAL bundled 7zz + REAL rar5 binding + REAL rar-rs CLI:
 * create archive → rebuild (extract → delete folder → re-compress) →
 * verify the folder is gone, the archive is intact, and 7zz can open it.
 * Gated on the local binaries; skipped where they are absent.
 */
import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { rebuildRarArchive } from "../src/providers/archive/rar5-modify";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

const BUNDLED_7ZZ = path.join(
  __dirname,
  "..",
  "7z-bin",
  "linux",
  "x64",
  "7zz",
);
const RAR_CLI = path.join(os.homedir(), "桌面", "rar-rs", "target", "release", "rar");
const UNRAR_CLI = path.join(os.homedir(), "桌面", "rar-rs", "target", "release", "unrar");
const BINDING = path.join(__dirname, "..", "rar5-bin", "linux", "x64", "smart-archive-rar.linux-x64-gnu.node");

function haveBinaries(): boolean {
  return (
    process.platform === "linux" &&
    fs.existsSync(BUNDLED_7ZZ) &&
    fs.existsSync(RAR_CLI) &&
    fs.existsSync(UNRAR_CLI) &&
    fs.existsSync(BINDING)
  );
}

describe("rar5 rebuild e2e (delete folder)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(haveBinaries())("deletes a folder inside a RAR archive and stays valid", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5e2e-"));
    const proj = path.join(dir, "proj");
    fs.mkdirSync(path.join(proj, "keep"), { recursive: true });
    fs.mkdirSync(path.join(proj, "drop", "sub"), { recursive: true });
    fs.mkdirSync(path.join(proj, "empty"), { recursive: true });
    fs.writeFileSync(path.join(proj, "keep", "a.txt"), "keep me");
    fs.writeFileSync(path.join(proj, "drop", "b.txt"), "drop me");
    fs.writeFileSync(path.join(proj, "drop", "sub", "c.txt"), "drop too");
    fs.writeFileSync(path.join(proj, "top.txt"), "top");

    const archive = path.join(dir, "out.rar");
    await compressWithRar5(
      {
        format: RAR5_FORMAT,
        outputPath: archive,
        targets: [{ fsPath: proj }],
        password: "",
        level: 3,
      },
      undefined,
      undefined,
      [],
    );

    let listing = childProcess.execFileSync(RAR_CLI, ["l", archive], { encoding: "utf8" });
    expect(listing).toContain("proj/drop/");
    expect(listing).toContain("proj/keep/a.txt");

    // The webview delete-folder flow: rebuild = extract → mutate → re-create.
    await rebuildRarArchive({
      archivePath: archive,
      mutate: (root) => {
        fs.rmSync(path.join(root, "proj", "drop"), { recursive: true, force: true });
      },
    });

    listing = childProcess.execFileSync(RAR_CLI, ["l", archive], { encoding: "utf8" });
    expect(listing).not.toContain("proj/drop");
    expect(listing).toContain("proj/keep/a.txt");
    expect(listing).toContain("proj/empty/");
    expect(listing).toContain("proj/top.txt");

    const testOut = childProcess.execFileSync(UNRAR_CLI, ["t", archive], { encoding: "utf8" });
    expect(testOut).toContain("All");
    expect(testOut).toContain("OK");

    // The rebuilt archive must be openable by the RAR-capable 7zz too.
    const szOut = childProcess.execFileSync(BUNDLED_7ZZ, ["l", archive], { encoding: "utf8" });
    expect(szOut).toContain("proj/keep/a.txt");
    expect(szOut).not.toContain("proj/drop");
  });
});
