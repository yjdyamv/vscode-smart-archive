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

  itOrSkip("detects unencrypted 7z archive", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_sz_enc_"));
    const src = path.join(tmpDir, "hello.txt");
    fs.writeFileSync(src, "plain text");
    const archive = path.join(tmpDir, "plain.7z");

    let r = spawnSync(sz!, ["a", "-t7z", archive, src], { stdio: "pipe", timeout: 30_000 });
    expect(r.status).toBe(0);

    // Simulate fixed behaviour: pipe empty password via stdin so 7z doesn't hang.
    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const stdout = r.stdout.toString();
    expect(stdout).toContain("hello.txt");
    expect(stdout).toContain("Encrypted = -");
    expect(stdout).not.toContain("Encrypted = +");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  itOrSkip("detects encrypted 7z with header encryption (-mhe=on)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_sz_enc_"));
    const src = path.join(tmpDir, "secret.txt");
    fs.writeFileSync(src, "classified");
    const archive = path.join(tmpDir, "secret.7z");

    let r = spawnSync(sz!, ["a", "-t7z", "-pp4ss", "-mhe=on", archive, src], {
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);

    // Listing with empty password — header-encrypted 7z fails to list
    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const stdout = r.stdout.toString();
    const combined = (stdout + r.stderr.toString()).toLowerCase();
    const isEnc = stdout.includes("Encrypted = +")
      || combined.includes("encrypt")
      || combined.includes("wrong password")
      || combined.includes("cannot open");
    expect(isEnc).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  itOrSkip("detects encrypted zip archive", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_sz_enc_"));
    const src = path.join(tmpDir, "data.txt");
    fs.writeFileSync(src, "sensitive");
    const archive = path.join(tmpDir, "locked.zip");

    let r = spawnSync(sz!, ["a", "-tzip", "-pzip4ss", archive, src], {
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);

    // zip has no header encryption — listing succeeds and shows Encrypted = +
    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const stdout = r.stdout.toString();
    expect(stdout).toContain("data.txt");
    expect(stdout).toContain("Encrypted = +");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  itOrSkip("detects unencrypted zip archive", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_sz_enc_"));
    const src = path.join(tmpDir, "info.txt");
    fs.writeFileSync(src, "public");
    const archive = path.join(tmpDir, "open.zip");

    let r = spawnSync(sz!, ["a", "-tzip", archive, src], { stdio: "pipe", timeout: 30_000 });
    expect(r.status).toBe(0);

    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const stdout = r.stdout.toString();
    expect(stdout).toContain("info.txt");
    expect(stdout).toContain("Encrypted = -");
    expect(stdout).not.toContain("Encrypted = +");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  itOrSkip("lists encrypted 7z with correct password via -p flag", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_sz_enc_"));
    const src = path.join(tmpDir, "correct.txt");
    fs.writeFileSync(src, "secret content");
    const archive = path.join(tmpDir, "correct.7z");

    let r = spawnSync(sz!, ["a", "-t7z", "-pp4ss", "-mhe=on", archive, src], {
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);

    // List with -pPASSWORD on command line (7z on Windows cannot read pw from stdin pipe)
    r = spawnSync(sz!, ["l", "-slt", "-pp4ss", archive], {
      stdio: "pipe",
      timeout: 10_000,
    });
    const stdout = r.stdout.toString();
    expect(stdout).toContain("correct.txt");
    expect(stdout).toContain("Encrypted = +");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  itOrSkip("encrypted 7z detection is fast (no stdin hang)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sat_sz_enc_"));
    const src = path.join(tmpDir, "fast.txt");
    fs.writeFileSync(src, "quick");
    const archive = path.join(tmpDir, "fast.7z");

    let r = spawnSync(sz!, ["a", "-t7z", "-pp4ss", "-mhe=on", archive, src], {
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);

    const start = Date.now();
    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const elapsed = Date.now() - start;
    // Should complete in under 5 seconds with ended stdin
    expect(elapsed).toBeLessThan(5000);

    fs.rmSync(tmpDir, { recursive: true, force: true });
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
