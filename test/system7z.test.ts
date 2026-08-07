/**
 * System 7-Zip tests — Smart Archive VSCode Extension
 *
 * Tests for: 7z detection, compress, decompress, list.
 * These tests require a system 7-Zip installation and are skipped otherwise.
 */

import { afterEach, describe, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import {
  compressWithSystem7z,
  detectSystem7z,
  resetDetectionCache,
} from "../src/engines/system7z";
import { itIf } from "./gates";
import { tmpDir } from "./tmp";

const { spawnSync } = require("child_process") as {
  spawnSync: (cmd: string, args: string[], opts?: Record<string, unknown>) => {
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
    error?: Error;
  };
};

// Use the engine's own detection (bundled 7-Zip ZS first, then a system
// install that passes its version/capability gates). CI runners often ship
// p7zip 16.02, which the engine rejects — those runs must skip, not fail.
const sz = detectSystem7z();

afterEach(() => {
  resetDetectionCache();
});

describe("system 7-Zip", () => {
  itIf("system7z", "detects system 7-Zip installation", () => {
    expect(sz).toBeTruthy();
    const r = spawnSync(sz!, [], { stdio: "pipe", timeout: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain("7-Zip");
  });

  itIf("system7z", "detects unencrypted 7z archive", () => {
    let tdir = tmpDir("sat_sz_enc_");
    const src = path.join(tdir, "hello.txt");
    fs.writeFileSync(src, "plain text");
    const archive = path.join(tdir, "plain.7z");

    let r = spawnSync(sz!, ["a", "-t7z", archive, src], { stdio: "pipe", timeout: 30_000 });
    expect(r.status).toBe(0);

    // Simulate fixed behaviour: pipe empty password via stdin so 7z doesn't hang.
    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const stdout = r.stdout.toString();
    expect(stdout).toContain("hello.txt");
    expect(stdout).toContain("Encrypted = -");
    expect(stdout).not.toContain("Encrypted = +");

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "detects encrypted 7z with header encryption (-mhe=on)", () => {
    let tdir = tmpDir("sat_sz_enc_");
    const src = path.join(tdir, "secret.txt");
    fs.writeFileSync(src, "classified");
    const archive = path.join(tdir, "secret.7z");

    let r = spawnSync(sz!, ["a", "-t7z", "-pp4ss", "-mhe=on", archive, src], {
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);

    // Listing with empty password — header-encrypted 7z must refuse to open
    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const combined = (r.stdout.toString() + r.stderr.toString()).toLowerCase();
    expect(r.status).not.toBe(0);
    expect(combined.includes("wrong password") || combined.includes("cannot open")).toBe(true);

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "detects encrypted zip archive", () => {
    let tdir = tmpDir("sat_sz_enc_");
    const src = path.join(tdir, "data.txt");
    fs.writeFileSync(src, "sensitive");
    const archive = path.join(tdir, "locked.zip");

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

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "detects unencrypted zip archive", () => {
    let tdir = tmpDir("sat_sz_enc_");
    const src = path.join(tdir, "info.txt");
    fs.writeFileSync(src, "public");
    const archive = path.join(tdir, "open.zip");

    let r = spawnSync(sz!, ["a", "-tzip", archive, src], { stdio: "pipe", timeout: 30_000 });
    expect(r.status).toBe(0);

    r = spawnSync(sz!, ["l", "-slt", "-p", archive], { stdio: "pipe", input: "", timeout: 10_000 });
    const stdout = r.stdout.toString();
    expect(stdout).toContain("info.txt");
    expect(stdout).toContain("Encrypted = -");
    expect(stdout).not.toContain("Encrypted = +");

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "lists encrypted 7z with correct password via -p flag", () => {
    let tdir = tmpDir("sat_sz_enc_");
    const src = path.join(tdir, "correct.txt");
    fs.writeFileSync(src, "secret content");
    const archive = path.join(tdir, "correct.7z");

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

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "encrypted 7z detection is fast (no stdin hang)", () => {
    let tdir = tmpDir("sat_sz_enc_");
    const src = path.join(tdir, "fast.txt");
    fs.writeFileSync(src, "quick");
    const archive = path.join(tdir, "fast.7z");

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

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "compresses and decompresses a directory", () => {
    let tdir = tmpDir("sat_sz_");
    const srcDir = path.join(tdir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "hello.txt"), "hello world");
    fs.writeFileSync(path.join(tdir, "readme.md"), "# test");

    const archive = path.join(tdir, "test.7z");
    const outDir = path.join(tdir, "out");

    let r = spawnSync(
      sz!,
      ["a", "-t7z", "-mx5", archive, srcDir, path.join(tdir, "readme.md")],
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

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "reports determinate progress (message + increment) while compressing", async () => {
    let tdir = tmpDir("sat_sz_prog_");
    const src = path.join(tdir, "data.bin");
    // Random data: incompressible, so LZMA2 takes long enough for the
    // size-based progress fallback to emit multiple percentage updates.
    const chunk = Buffer.alloc(64 * 1024 * 1024);
    for (let i = 0; i < chunk.length; i += 4) {
      chunk.writeUInt32LE((i * 2654435761) >>> 0, i);
    }
    fs.writeFileSync(src, chunk);
    const archive = path.join(tdir, "progress.7z");

    const reports: { message?: string; increment?: number }[] = [];
    await compressWithSystem7z(
      {
        targets: [{ fsPath: src }],
        format: { label: "7z", description: "", canCreate: true, supportsEncryption: true },
        outputPath: archive,
        password: "",
        level: 5,
      },
      { report: (r) => reports.push(r) },
    );

    expect(fs.existsSync(archive)).toBe(true);
    const pctReports = reports.filter((r) => r.message?.match(/^\d+%$/));
    expect(pctReports.length).toBeGreaterThan(0);
    expect(pctReports.some((r) => (r.increment ?? 0) > 0)).toBe(true);

    fs.rmSync(tdir, { recursive: true, force: true });
  });

  itIf("system7z", "reports determinate progress for multi-volume compression", async () => {
    let tdir = tmpDir("sat_sz_volprog_");
    const src = path.join(tdir, "data.bin");
    // Incompressible random data split into several 1m volumes; the size
    // monitor must follow .001/.002/… because the base archive is never
    // written in volume mode.
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < chunk.length; i += 4) {
      chunk.writeUInt32LE((i * 2654435761) >>> 0, i);
    }
    fs.writeFileSync(src, chunk);
    const archive = path.join(tdir, "progress.7z");

    const reports: { message?: string; increment?: number }[] = [];
    await compressWithSystem7z(
      {
        targets: [{ fsPath: src }],
        format: { label: "7z", description: "", canCreate: true, supportsEncryption: true },
        outputPath: archive,
        password: "",
        level: 5,
        volumeSize: "1m",
      },
      { report: (r) => reports.push(r) },
    );

    expect(fs.existsSync(`${archive}.001`)).toBe(true);
    expect(fs.existsSync(`${archive}.002`)).toBe(true);
    const pctReports = reports.filter((r) => r.message?.match(/^\d+%$/));
    expect(pctReports.length).toBeGreaterThan(0);
    expect(pctReports.some((r) => (r.increment ?? 0) > 0)).toBe(true);

    fs.rmSync(tdir, { recursive: true, force: true });
  });
});
