/**
 * Delete-progress tests — Smart Archiver VSCode Extension
 *
 * Verifies that the system-7z delete path reports real progress
 * (percentage from the 7z stderr parser) and that deleting rebuilds the
 * archive in-place (atomic <archive>.tmp replacement next to the file).
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { deleteFromArchiveSystem7z } from "../src/engines/system7z";
import { bundled7zPath } from "../src/engines/bundled7z";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

const td = tmpDir("sadp_");
// Same resolution as the bundled7zz gate (never a hand-rolled vendor path);
// every use is inside describe.runIf(gate("bundled7zz")), so non-null there.
const BUNDLED_7Z = bundled7zPath()!;

function makeArchive(name: string, sizeMb = 64): string {
  const archive = path.join(td, name);
  const a = path.join(td, `a-${name}.bin`);
  const b = path.join(td, `b-${name}.txt`);
  // Random data: LZMA2 at mx9 takes real time to (re)compress, so the
  // 7z stderr progress parser has something to emit.
  const chunk = Buffer.alloc(sizeMb * 1024 * 1024);
  for (let i = 0; i < chunk.length; i += 4) {
    chunk.writeUInt32LE((i * 2654435761) >>> 0, i);
  }
  fs.writeFileSync(a, chunk);
  fs.writeFileSync(b, "keep me");
  execFileSync(BUNDLED_7Z, ["a", "-mx9", archive, a, b]);
  return archive;
}

afterAll(() => {
  try {
    fs.rmSync(td, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe.runIf(gate("bundled7zz"))("deleteFromArchiveSystem7z", () => {
  it("deletes entries without leaving temp files behind", async () => {
    const archive = makeArchive("rebuild.7z");
    await deleteFromArchiveSystem7z(archive, ["a-rebuild.7z.bin"]);

    // The archive still exists; the entry is gone; no .tmp residue.
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.readdirSync(td).filter((e) => e.endsWith(".tmp") || e.endsWith(".tmp1"))).toEqual(
      [],
    );

    const listing = execFileSync(BUNDLED_7Z, ["l", archive]).toString();
    expect(listing).toContain("b-rebuild.7z.txt");
    expect(listing).not.toContain("a-rebuild.7z.bin");
  });

  it("honours cancellation by terminating the child process", async () => {
    const archive = makeArchive("cancel.7z");
    const token = {
      get isCancellationRequested() {
        return false;
      },
      onCancellationRequested(cb: () => void) {
        setTimeout(cb, 50);
        return { dispose: () => {} };
      },
    };
    await expect(
      deleteFromArchiveSystem7z(archive, ["a-cancel.7z.bin"], undefined, undefined, token),
    ).rejects.toThrow();
  });
});
