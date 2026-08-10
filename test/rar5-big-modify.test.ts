/**
 * Manual big-archive e2e: append/delete on a ~256 MB RAR5 archive without
 * rebuilding. Verifies kept members stay byte-identical (sha256) and that
 * rar-rs CLI still validates the archive. Run on demand:
 *   npx vitest run test/tmp-big-e2e.test.ts
 */
import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  compressWithRar5,
  appendWithRar5,
  deleteWithRar5,
  listRar5Entries,
} from "../src/engines/rar5-engine";
import { rar5CliBinaries } from "./gates";

// 1.2 GiB end-to-end append/delete; opt-in so the default suite stays fast:
//   SAT_BIG_E2E=1 npx vitest run test/rar5-big-modify.test.ts

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

const RAR_CLI = rar5CliBinaries().rar;

function sha256File(p: string): string | null {
  if (!fs.statSync(p).isFile()) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function run(bin: string, args: string[]): string {
  return childProcess.execFileSync(bin, args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

describe("big archive direct modify (manual)", () => {
  it.runIf(process.env.SAT_BIG_E2E === "1")(
    "appends and deletes on a 1.2GB RAR without rebuilding",
    async () => {
    // Disk-backed work dir (os.tmpdir may be a small tmpfs) so the 1.2GB
    // archive plus two extraction copies fit comfortably.
    const dir = fs.mkdtempSync(path.join("/home/yuan/.sat-big-e2e-"));
    const src = path.join(dir, "big.bin");
    const chunk = crypto.randomBytes(4 * 1024 * 1024);
    const fh = fs.openSync(src, "w");
    for (let i = 0; i < 300; i++) fs.writeSync(fh, chunk); // 1.2 GiB
    fs.closeSync(fh);
    const archive = path.join(dir, "big.rar");

    // 1) create the archive: big store + a few small files
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.copyFileSync(src, path.join(proj, "big.bin"));
    fs.rmSync(src, { force: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(proj, `f${i}.txt`), `content ${i}\n`);
    }
    let t0 = Date.now();
    await compressWithRar5(
      { format: RAR5_FORMAT, outputPath: archive, targets: [{ fsPath: proj }], level: 0 },
      undefined,
      undefined,
      [],
    );
    console.log(`[create] ${Date.now() - t0} ms, size=${fs.statSync(archive).size}`);

    // baseline hashes of every member
    const baseNames = listRar5Entries(archive);
    console.log(`[members] ${baseNames.length}`);
    const baseHashes: Record<string, string> = {};
    const listOut = run(RAR_CLI, ["l", archive]);
    expect(listOut).toContain("proj/big.bin");

    // extract everything for byte-level hashes (baseline)
    const x0 = path.join(dir, "x0");
    run(RAR_CLI, ["x", archive, x0 + "/"]);
    for (const n of baseNames) {
      const h = sha256File(path.join(x0, n));
      if (h) baseHashes[n] = h;
    }

    // 2) APPEND: a new directory with 5 files (no rebuild)
    const extra = path.join(dir, "extra");
    fs.mkdirSync(path.join(extra, "sub"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(extra, `n${i}.txt`), `added ${i}\n`);
    }
    fs.writeFileSync(path.join(extra, "sub", "deep.txt"), "deep");
    t0 = Date.now();
    await appendWithRar5(archive, [extra], "proj", "", []);
    const appendMs = Date.now() - t0;
    console.log(`[append] ${appendMs} ms, size=${fs.statSync(archive).size}`);

    const afterAppend = listRar5Entries(archive);
    expect(afterAppend).toContain("proj/extra/n0.txt");
    expect(afterAppend).toContain("proj/extra/sub/deep.txt");

    // 3) DELETE the appended directory (no rebuild)
    t0 = Date.now();
    const deleted = deleteWithRar5(archive, ["proj/extra"], "");
    const deleteMs = Date.now() - t0;
    console.log(`[delete] ${deleteMs} ms (${deleted} members), size=${fs.statSync(archive).size}`);

    const afterDelete = listRar5Entries(archive);
    expect(afterDelete).not.toContain("proj/extra/n0.txt");
    expect(afterDelete).not.toContain("proj/extra/sub/deep.txt");

    // 4) byte-identical verification of every kept member + archive validity
    const x1 = path.join(dir, "x1");
    run(RAR_CLI, ["x", archive, x1 + "/"]);
    for (const n of Object.keys(baseHashes)) {
      const h = sha256File(path.join(x1, n));
      console.log(`[verify] ${n}: ${h === baseHashes[n] ? "IDENTICAL" : "MISMATCH"}`);
      expect(h).toBe(baseHashes[n]);
    }
    const tOut = run(RAR_CLI, ["t", archive]);
    console.log(`[test] ${tOut.split("\n").filter((l) => l.trim()).length} lines`);
    expect(tOut).toContain("OK");
    expect(tOut).not.toContain("rror");

    console.log(`[summary] append=${appendMs}ms delete=${deleteMs}ms on ${fs.statSync(archive).size} bytes`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
