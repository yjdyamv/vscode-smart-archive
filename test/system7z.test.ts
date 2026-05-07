/**
 * System 7-Zip tests — Smart Archive VSCode Extension
 *
 * Tests for: 7z detection, compress, decompress, list.
 * These tests require a system 7-Zip installation and are skipped otherwise.
 */

import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const { spawnSync } = require("child_process") as {
  spawnSync: (cmd: string, args: string[], opts?: Record<string, unknown>) => {
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
    error?: Error;
  };
};

function find7z(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\7-Zip\\7z.exe",
      "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    );
  }
  candidates.push("7z", "7z.exe", "7za", "7za.exe");

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const r = spawnSync(c, [], { stdio: "pipe", timeout: 5000 });
      if (r.status === 0) return c;
    }
  }

  for (const name of process.platform === "win32" ? ["7z.exe", "7za.exe"] : ["7z", "7za"]) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const r = spawnSync(whichCmd, [name], { stdio: "pipe", timeout: 5000 });
      if (r.status === 0 && r.stdout.length > 0) {
        const found = r.stdout.toString().trim().split("\n")[0].trim();
        if (fs.existsSync(found)) return found;
      }
    } catch {
      continue;
    }
  }
  return null;
}

const sz = find7z();
const itOrSkip = sz ? it : it.skip;

describe("system 7-Zip", () => {
  itOrSkip("detects system 7-Zip installation", () => {
    expect(sz).toBeTruthy();
    const r = spawnSync(sz!, [], { stdio: "pipe", timeout: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain("7-Zip");
  });

  itOrSkip("compresses and decompresses a directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_sz_"));
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "hello.txt"), "hello world");
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# test");

    const archive = path.join(tmpDir, "test.7z");
    const outDir = path.join(tmpDir, "out");

    let r = spawnSync(
      sz!,
      ["a", "-t7z", "-mx5", archive, srcDir, path.join(tmpDir, "readme.md")],
      { stdio: "pipe", timeout: 30_000 },
    );
    expect(r.status).toBe(0);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.statSync(archive).size).toBeGreaterThan(0);

    r = spawnSync(sz!, ["l", "-slt", archive], { stdio: "pipe", timeout: 10_000 });
    const listing = r.stdout.toString();
    expect(listing).toContain("hello.txt");
    expect(listing).toContain("readme.md");

    r = spawnSync(sz!, ["x", `-o${outDir}`, archive], { stdio: "pipe", timeout: 30_000 });
    expect(r.status).toBe(0);

    const outSrc = path.join(outDir, "src", "hello.txt");
    const outReadme = path.join(outDir, "readme.md");
    expect(fs.existsSync(outSrc)).toBe(true);
    expect(fs.existsSync(outReadme)).toBe(true);
    expect(fs.readFileSync(outSrc, "utf-8")).toBe("hello world");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
