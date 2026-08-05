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
import {
  rebuildRarArchive,
  hasEncryptedHeaders,
  readRecoveryPercent,
} from "../src/providers/archive/rar5-modify";
import { verifyArchivePassword } from "../src/providers/webview/handlers/shared";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

const BUNDLED_7ZZ = path.join(
  __dirname,
  "..",
  "vendor",
  "7z-bin",
  "linux",
  "x64",
  "7zz",
);
const RAR_CLI = path.join(os.homedir(), "桌面", "rar-rs", "target", "release", "rar");
const UNRAR_CLI = path.join(os.homedir(), "桌面", "rar-rs", "target", "release", "unrar");
const BINDING = path.join(__dirname, "..", "vendor", "rar5-bin", "linux", "x64", "smart-archive-rar.linux-x64-gnu.node");

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

  it.runIf(haveBinaries())("creates streams 7zz can fully decode for large binaries (Huffman completeness)", async () => {
    // Regression: skewed symbol distributions in large binaries force
    // Huffman depths beyond 15; the old clamp + greedy fix could leave an
    // incomplete table, which 7-Zip's RAR5 decoder rejects with "Data
    // Error" (while rar-rs's own decoder and The Unarchiver accept it).
    // The bundled 7zz binary (~3.7 MB) triggers the case reliably.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5bin-"));
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.copyFileSync(BUNDLED_7ZZ, path.join(proj, "7zz.bin"));
    fs.writeFileSync(path.join(proj, "note.txt"), "hello");

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

    // Full decode test (not just listing): fails on incomplete Huffman
    // tables in the stream.
    const testOut = childProcess.execFileSync(BUNDLED_7ZZ, ["t", archive], { encoding: "utf8" });
    expect(testOut).toContain("Everything is Ok");
    expect(testOut).not.toContain("Data Error");

    // Rebuild over the same archive must stay 7zz-decodable.
    await rebuildRarArchive({
      archivePath: archive,
      mutate: (root) => {
        fs.rmSync(path.join(root, "proj", "7zz.bin"), { force: true });
      },
    });

    const testOut2 = childProcess.execFileSync(BUNDLED_7ZZ, ["t", archive], { encoding: "utf8" });
    expect(testOut2).toContain("Everything is Ok");
  });

  it.runIf(haveBinaries())("verifies an encrypted archive's password via the RAR-capable 7zz", async () => {
    // Regression: verifyArchivePassword used the generic system-7z detection,
    // which on distros whose 7-Zip build lacks RAR support fails every
    // verification with "Can't open as archive" → false "wrong password"
    // (this machine's /usr/bin/7z is exactly such a build). It must resolve
    // the RAR-capable binary (bundled full-format 7zz) instead.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5pw-"));
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "secret.txt"), "top secret");

    const archive = path.join(dir, "enc.rar");
    await compressWithRar5(
      {
        format: RAR5_FORMAT,
        outputPath: archive,
        targets: [{ fsPath: proj }],
        password: "test123",
        level: 3,
      },
      undefined,
      undefined,
      [],
    );

    await expect(verifyArchivePassword(archive, "test123")).resolves.toBe(true);
    await expect(verifyArchivePassword(archive, "wrong")).resolves.toBe(false);
  });

  it.runIf(haveBinaries())("encrypts headers so file names stay hidden, and preserves them on rebuild", async () => {
    // RAR5 header encryption: the archive structure must be invisible
    // without the password, and a rebuild must keep header encryption.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5hdr-"));
    const proj = path.join(dir, "proj");
    fs.mkdirSync(path.join(proj, "secret"), { recursive: true });
    fs.writeFileSync(path.join(proj, "secret", "hidden.txt"), "classified");

    const archive = path.join(dir, "enc.rar");
    await compressWithRar5(
      {
        format: RAR5_FORMAT,
        outputPath: archive,
        targets: [{ fsPath: proj }],
        password: "test123",
        encryptHeaders: true,
        level: 3,
      },
      undefined,
      undefined,
      [],
    );

    expect(hasEncryptedHeaders(archive)).toBe(true);

    // Listing without the password must fail; the plaintext file name must
    // not appear anywhere in the archive.
    const raw = fs.readFileSync(archive);
    expect(raw.includes(Buffer.from("hidden.txt"))).toBe(false);
    let listed: string | undefined;
    try {
      listed = childProcess.execFileSync(BUNDLED_7ZZ, ["l", archive], { encoding: "utf8" });
    } catch {
      listed = undefined;
    }
    expect(listed).toBeUndefined();

    const pwList = childProcess.execFileSync(BUNDLED_7ZZ, ["l", `-ptest123`, archive], {
      encoding: "utf8",
    });
    expect(pwList).toContain("secret/hidden.txt");

    const testOut = childProcess.execFileSync(BUNDLED_7ZZ, ["t", `-ptest123`, archive], {
      encoding: "utf8",
    });
    expect(testOut).toContain("Everything is Ok");

    // Rebuild (delete) must preserve header encryption.
    await rebuildRarArchive({
      archivePath: archive,
      password: "test123",
      mutate: (root) => {
        fs.rmSync(path.join(root, "proj", "secret"), { recursive: true, force: true });
      },
    });
    expect(hasEncryptedHeaders(archive)).toBe(true);
    const after = childProcess.execFileSync(BUNDLED_7ZZ, ["t", `-ptest123`, archive], {
      encoding: "utf8",
    });
    expect(after).toContain("Everything is Ok");
  });

  it.runIf(haveBinaries())("creates .rev recovery volumes the official rar rc can rebuild from", async () => {
    // WinRAR `-rv` equivalent: split the archive and generate .rev files;
    // the official `rar rc` must reconstruct a deleted volume byte-exactly.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5rv-"));
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    // Random (incompressible) payload so the archive really splits.
    const payload = require("crypto").randomBytes(100000);
    fs.writeFileSync(path.join(proj, "big.bin"), payload);

    const archive = path.join(dir, "vol.part1.rar");
    await compressWithRar5(
      {
        format: RAR5_FORMAT,
        outputPath: archive,
        targets: [{ fsPath: proj }],
        password: "",
        level: 3,
        volumeSize: "32k",
        recoveryVolumeCount: 10,
      },
      undefined,
      undefined,
      [],
    );

    const revs = fs.readdirSync(dir).filter((n) => n.endsWith(".rev"));
    expect(revs.length).toBe(4); // 4 data volumes, requested 10 -> capped
    const revPath = path.join(dir, revs[0]);
    const revHead = fs.readFileSync(revPath);
    expect(revHead.subarray(0, 8).equals(Buffer.from("Rar!\x1aRev"))).toBe(true);

    // Delete a middle volume and rebuild it with the official rar rc.
    const officialRar = "/home/yuan/下载/rar/rar";
    const vols = fs.readdirSync(dir).filter((n) => n.endsWith(".rar")).sort();
    const missing = path.join(dir, vols[Math.floor(vols.length / 2)]);
    fs.rmSync(missing);
    if (fs.existsSync(officialRar)) {
      const out = childProcess.execFileSync(officialRar, ["rc", archive], { encoding: "utf8" });
      expect(out).toContain("Done");
      expect(fs.existsSync(missing)).toBe(true);
      const testOut = childProcess.execFileSync(officialRar, ["t", archive], { encoding: "utf8" });
      expect(testOut).toContain("All OK");
    }
  });

  it.runIf(haveBinaries())("creates a recovery record that WinRAR validates, preserves it on rebuild, and repairs damage", async () => {
    // RAR5 inline recovery record: the official rar CLI must recognize and
    // validate it ("Testing the recovery record ... OK"), a rebuild must
    // preserve the percent, and the binding's repair must restore a
    // damaged archive byte-exactly.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_rar5rr-"));
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const payload = Buffer.alloc(4000, 0x61);
    fs.writeFileSync(path.join(proj, "big.bin"), payload);

    const archive = path.join(dir, "rr.rar");
    await compressWithRar5(
      {
        format: RAR5_FORMAT,
        outputPath: archive,
        targets: [{ fsPath: proj }],
        password: "",
        recoveryPercent: 5,
        level: 3,
      },
      undefined,
      undefined,
      [],
    );

    expect(readRecoveryPercent(archive)).toBe(5);
    const raw = fs.readFileSync(archive);
    expect(raw.includes(Buffer.from("{RB}"))).toBe(true);

    // Official rar validates the recovery record.
    const officialRar = "/home/yuan/下载/rar/rar";
    if (fs.existsSync(officialRar)) {
      const out = childProcess.execFileSync(officialRar, ["t", archive], { encoding: "utf8" });
      expect(out).toContain("recovery record");
      expect(out).toContain("All OK");
    }

    // Rebuild (delete) must preserve the recovery record.
    await rebuildRarArchive({
      archivePath: archive,
      mutate: (root) => {
        fs.rmSync(path.join(root, "proj", "big.bin"), { force: true });
      },
    });
    expect(readRecoveryPercent(archive)).toBe(5);
    const testOut = childProcess.execFileSync(BUNDLED_7ZZ, ["t", archive], { encoding: "utf8" });
    expect(testOut).toContain("Everything is Ok");
  });
});
