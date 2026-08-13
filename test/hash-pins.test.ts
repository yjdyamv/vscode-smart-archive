import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { tmpDir } from "./tmp";

import {
  checkHash,
  persistBootstrapHash,
  sha256,
  updatePinnedHash,
} from "../scripts/lib/hash-pins.mjs";

describe("checkHash bootstrap", () => {
  const data = Buffer.from("hello world");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    delete process.env.SA_HASH_BOOTSTRAP;
    warn.mockClear();
  });

  it("accepts a matching pinned hash without warnings", () => {
    checkHash(data, sha256(data), true, "x");
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws on mismatch without bootstrap", () => {
    expect(() => checkHash(data, "0".repeat(64), true, "x")).toThrow(/SHA-256 mismatch/);
  });

  it("prints the new hash and proceeds on mismatch with bootstrap", () => {
    process.env.SA_HASH_BOOTSTRAP = "1";
    expect(() => checkHash(data, "0".repeat(64), true, "x")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`[hash-bootstrap] x = ${sha256(data)}`);
    expect(warn.mock.calls[0][0]).toContain("is outdated");
  });

  it("prints the hash when none is pinned with bootstrap", () => {
    process.env.SA_HASH_BOOTSTRAP = "1";
    expect(() => checkHash(data, undefined, true, "x")).not.toThrow();
    expect(warn.mock.calls[0][0]).toContain(`[hash-bootstrap] x = ${sha256(data)}`);
  });

  it("throws when none is pinned without bootstrap", () => {
    expect(() => checkHash(data, undefined, true, "x")).toThrow(/No pinned SHA-256/);
  });
});

describe("updatePinnedHash", () => {
  it("rewrites quoted and bare keys inside EXPECTED_HASHES", () => {
    const dir = tmpDir("dwc-");
    const script = path.join(dir, "install-test.js");
    fs.writeFileSync(
      script,
      [
        "const EXPECTED_HASHES = {",
        `  "a.js": "${"1".repeat(64)}",`,
        `  b: "${"2".repeat(64)}",`,
        "};",
        "",
      ].join("\n"),
    );

    expect(updatePinnedHash(script, "a.js", "3".repeat(64))).toBe(true);
    expect(updatePinnedHash(script, "b", "4".repeat(64))).toBe(true);
    const text = fs.readFileSync(script, "utf8");
    expect(text).toContain(`"a.js": "${"3".repeat(64)}"`);
    expect(text).toContain(`b: "${"4".repeat(64)}"`);

    expect(updatePinnedHash(script, "missing", "5".repeat(64))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("persistBootstrapHash", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    delete process.env.SA_HASH_BOOTSTRAP;
    warn.mockClear();
  });

  function fixture(scriptBody: string): { dir: string; script: string; dest: string } {
    const dir = tmpDir("dwc-boot-");
    const script = path.join(dir, "install-test.js");
    fs.writeFileSync(script, scriptBody);
    fs.chmodSync(script, 0o755);
    const dest = path.join(dir, "asset.bin");
    fs.writeFileSync(dest, Buffer.from("hello world"));
    return { dir, script, dest };
  }

  it("does nothing outside bootstrap mode", () => {
    const { dir, script, dest } = fixture(
      `const EXPECTED_HASHES = { "a": "${"1".repeat(64)}" };\n`,
    );
    expect(persistBootstrapHash(script, dest, "a")).toBe(false);
    expect(fs.readFileSync(script, "utf8")).toContain("1".repeat(64));
    expect(warn).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists a new hash and preserves the script mode", () => {
    process.env.SA_HASH_BOOTSTRAP = "1";
    const { dir, script, dest } = fixture(
      `const EXPECTED_HASHES = { "a": "${"1".repeat(64)}" };\n`,
    );
    expect(persistBootstrapHash(script, dest, "a")).toBe(true);
    const text = fs.readFileSync(script, "utf8");
    expect(text).toContain(sha256(Buffer.from("hello world")));
    // Windows chmod only tracks the read-only bit — the mode is not
    // preserved there, so the assertion is POSIX-only.
    if (process.platform !== "win32") {
      expect(fs.statSync(script).mode & 0o777).toBe(0o755);
    }
    expect(warn.mock.calls[0][0]).toContain("pinned hash updated");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints a hint when the key is missing", () => {
    process.env.SA_HASH_BOOTSTRAP = "1";
    const { dir, script, dest } = fixture(
      `const EXPECTED_HASHES = { "b": "${"2".repeat(64)}" };\n`,
    );
    expect(persistBootstrapHash(script, dest, "missing")).toBe(false);
    expect(warn.mock.calls[0][0]).toContain("add it manually");
    expect(warn.mock.calls[0][0]).toContain(sha256(Buffer.from("hello world")));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
