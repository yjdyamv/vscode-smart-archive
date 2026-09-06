/**
 * Manual encrypted-archive e2e: append/delete on password-protected RAR5
 * archives (file-level encryption and header encryption) without rebuild.
 *   npx vitest run test/tmp-encrypted-e2e.test.ts
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

function sha256(p: string): string | null {
  if (!fs.statSync(p).isFile()) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

async function scenario(dir: string, label: string, encryptHeaders: boolean) {
  const proj = path.join(dir, "proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "a.txt"), "alpha data ".repeat(2000));
  fs.writeFileSync(path.join(proj, "b.txt"), "beta data ".repeat(2000));
  const archive = path.join(dir, "enc.rar");
  await compressWithRar5(
    {
      format: RAR5_FORMAT,
      outputPath: archive,
      targets: [{ fsPath: proj }],
      password: "pw123",
      encryptHeaders,
      level: 3,
    },
    undefined,
    undefined,
    [],
  );

  // Baseline: extract with password, hash members
  const x0 = path.join(dir, "x0");
  run(RAR_CLI, ["x", "-p", "pw123", archive, x0 + "/"]);
  const baseHashes: Record<string, string> = {};
  for (const n of await listRar5Entries(archive, "pw123")) {
    const h = sha256(path.join(x0, n));
    if (h) baseHashes[n] = h;
  }
  // Header-encrypted archives hide member names without the password.
  if (encryptHeaders) {
    // Header-encrypted archives refuse to list without the password.
    await expect(listRar5Entries(archive)).rejects.toThrow(/password|encrypted/i);
  } else {
    expect((await listRar5Entries(archive)).length).toBeGreaterThan(0);
  }

  // APPEND with password
  const extra = path.join(dir, "extra");
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, "n.txt"), "new member");
  const t0 = Date.now();
  await appendWithRar5(archive, [extra], "proj", "pw123", []);
  const appendMs = Date.now() - t0;

  // member visible with password; list without password must fail for header-encrypted
  const names = await listRar5Entries(archive, "pw123");
  expect(names).toContain("proj/extra/n.txt");
  expect(names).toContain("proj/a.txt");

  // DELETE with password (directory selection)
  const t1 = Date.now();
  const deleted = await deleteWithRar5(archive, ["proj/extra"], "pw123");
  const deleteMs = Date.now() - t1;
  expect(deleted).toBeGreaterThan(0);

  const after = await listRar5Entries(archive, "pw123");
  expect(after).not.toContain("proj/extra/n.txt");

  // Byte-level verification of kept members
  const x1 = path.join(dir, "x1");
  run(RAR_CLI, ["x", "-p", "pw123", archive, x1 + "/"]);
  for (const n of Object.keys(baseHashes)) {
    const h = sha256(path.join(x1, n));
    expect(h).toBe(baseHashes[n]);
  }
  const tOut = run(RAR_CLI, ["t", "-p", "pw123", archive]);
  expect(tOut).toContain("OK");
  console.log(`[${label}] append=${appendMs}ms delete=${deleteMs}ms, all members IDENTICAL`);
}

describe.runIf(HAVE_BINARIES)("encrypted archive direct modify (manual)", () => {
  it("file-encrypted archive", async () => {
    const dir = tmpDir("sat_encfile-");
    try {
      await scenario(dir, "file-encrypted", false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("header-encrypted archive", async () => {
    const dir = tmpDir("sat_enchdr-");
    try {
      await scenario(dir, "header-encrypted", true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
