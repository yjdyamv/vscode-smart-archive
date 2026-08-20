/**
 * Windows reserved device names — Smart Archiver VSCode Extension
 *
 * DOS device names (CON, NUL, COM1-9, LPT1-9, …) and trailing dots/spaces
 * are legal in Unix archives but cannot be created on NTFS — Windows
 * resolves them to hardware or silently strips characters. Extraction
 * must skip them (warn) instead of writing to a device or failing.
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { copyDirFromFS } from "../src/utils/fs";
import { isReservedWinName } from "../src/utils/security";
import { logger } from "../src/utils/logger-core";
import type { JS7zInstance } from "../src/types";
import { tmpDir } from "./tmp";

/** Minimal virtual-FS stub with a fixed entry list. */
function mockJs7z(entries: string[], files: Record<string, string>): JS7zInstance {
  const readFile = (p: string): Uint8Array => {
    const content = files[p];
    if (content === undefined) throw new Error(`no fake file ${p}`);
    return Buffer.from(content);
  };
  return {
    FS: {
      readdir: (p: string) => (p === "/in" ? entries : []),
      stat: (p: string) => ({ mode: 0o100644, size: (files[p] ?? "").length }),
      isDir: (mode: number) => (mode & 0o170000) === 0o040000,
      readFile,
      mkdir: () => {},
    },
  } as unknown as JS7zInstance;
}

describe("isReservedWinName classification", () => {
  it("detects DOS device names case-insensitively, with or without extension", () => {
    expect(isReservedWinName("CON")).toBe(true);
    expect(isReservedWinName("con")).toBe(true);
    expect(isReservedWinName("CON.txt")).toBe(true);
    expect(isReservedWinName("aux.md")).toBe(true);
    expect(isReservedWinName("NUL")).toBe(true);
    expect(isReservedWinName("com1.log")).toBe(true);
    expect(isReservedWinName("LPT9")).toBe(true);
    expect(isReservedWinName("conin$")).toBe(true);
    expect(isReservedWinName("CONOUT$")).toBe(true);
    expect(isReservedWinName("CLOCK$")).toBe(true);
    expect(isReservedWinName("clock$.txt")).toBe(true);
  });

  it("detects control characters and Windows-forbidden characters", () => {
    expect(isReservedWinName("tab\there.md")).toBe(true);
    expect(isReservedWinName("a<b>.txt")).toBe(true);
    expect(isReservedWinName("why?.md")).toBe(true);
    expect(isReservedWinName('say"hi.txt')).toBe(true);
    expect(isReservedWinName("a|b.txt")).toBe(true);
    expect(isReservedWinName("a*b.txt")).toBe(true);
  });

  it("accepts ordinary names", () => {
    expect(isReservedWinName("readme.md")).toBe(false);
    expect(isReservedWinName("comic.txt")).toBe(false);
    expect(isReservedWinName("conserver.ts")).toBe(false);
    expect(isReservedWinName("console.log")).toBe(false);
    expect(isReservedWinName("auxiliary")).toBe(false);
    expect(isReservedWinName("COM10")).toBe(false);
  });

  it("rejects trailing dots and spaces (Windows silently strips them)", () => {
    expect(isReservedWinName("foo.")).toBe(true);
    expect(isReservedWinName("foo ")).toBe(true);
    expect(isReservedWinName("foo..")).toBe(true);
  });
});

describe("extraction skips reserved names", () => {
  it("extracts ok.txt but skips CON.txt with a warning", () => {
    const outDir = tmpDir("sat_reserved_");

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const copied = copyDirFromFS(
      mockJs7z(["CON.txt", "ok.txt"], { "/in/ok.txt": "hello" }),
      "/in",
      outDir,
    );

    expect(copied).toBe("hello".length);
    expect(fs.readFileSync(path.join(outDir, "ok.txt"), "utf8")).toBe("hello");
    expect(fs.existsSync(path.join(outDir, "CON.txt"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fs.reservedNameSkip" }),
      expect.any(String),
    );
  });
});