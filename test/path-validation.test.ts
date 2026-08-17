/**
 * Path/name validation tests — Smart Archiver VSCode Extension
 *
 * Locks the webview defense-in-depth whitelist: entry paths and entry names
 * that reach filesystem operations must never be "", ".", "..", absolute,
 * or carry native separators. These are the guards that turn a crafted
 * webview message into a no-op instead of a deleted archive tree.
 *
 * @module test/path-validation
 */

import { describe, it, expect } from "vitest";
import { isValidArchivePath, isValidEntryName } from "../src/utils/security";
import { isValidMsg } from "../src/providers/webview/router";

describe("isValidArchivePath", () => {
  it("accepts ordinary relative entry paths", () => {
    expect(isValidArchivePath("file.txt")).toBe(true);
    expect(isValidArchivePath("dir/file.txt")).toBe(true);
    expect(isValidArchivePath("a/b/c/d.txt")).toBe(true);
    expect(isValidArchivePath("dir/")).toBe(true); // trailing slash tolerated
    expect(isValidArchivePath("./file.txt")).toBe(true); // 7z listings may emit "./"
    expect(isValidArchivePath("./dir/file.txt")).toBe(true);
  });

  it("rejects empty, dot and dot-dot paths", () => {
    expect(isValidArchivePath("")).toBe(false);
    expect(isValidArchivePath(".")).toBe(false);
    expect(isValidArchivePath("..")).toBe(false);
    expect(isValidArchivePath("../x")).toBe(false);
    expect(isValidArchivePath("a/../b")).toBe(false);
    expect(isValidArchivePath("a/./b")).toBe(false);
    expect(isValidArchivePath("..")).toBe(false);
  });

  it("rejects absolute paths and drive letters", () => {
    expect(isValidArchivePath("/etc/passwd")).toBe(false);
    expect(isValidArchivePath("//server/share")).toBe(false);
    expect(isValidArchivePath("C:/windows")).toBe(false);
    expect(isValidArchivePath("c:\\windows")).toBe(false);
  });

  it("rejects backslashes, empty segments and overlong paths", () => {
    expect(isValidArchivePath("a\\b")).toBe(false);
    expect(isValidArchivePath("a//b")).toBe(false);
    expect(isValidArchivePath("a/")).toBe(true); // single trailing slash ok
    expect(isValidArchivePath("a/b/")).toBe(true);
    expect(isValidArchivePath("a".repeat(4097))).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidArchivePath(null as unknown as string)).toBe(false);
    expect(isValidArchivePath(undefined as unknown as string)).toBe(false);
    expect(isValidArchivePath(42 as unknown as string)).toBe(false);
  });
});

describe("isValidEntryName", () => {
  it("accepts ordinary names", () => {
    expect(isValidEntryName("file.txt")).toBe(true);
    expect(isValidEntryName("新建文件夹")).toBe(true);
    expect(isValidEntryName("a b c")).toBe(true);
    expect(isValidEntryName("-leading-dash")).toBe(true);
  });

  it("rejects dot names, separators and reserved characters", () => {
    expect(isValidEntryName(".")).toBe(false);
    expect(isValidEntryName("..")).toBe(false);
    expect(isValidEntryName("a/b")).toBe(false);
    expect(isValidEntryName("a\\b")).toBe(false);
    expect(isValidEntryName("a<b")).toBe(false);
    expect(isValidEntryName("a>b")).toBe(false);
    expect(isValidEntryName('a"b')).toBe(false);
    expect(isValidEntryName("a:b")).toBe(false);
    expect(isValidEntryName("a|b")).toBe(false);
    expect(isValidEntryName("a?b")).toBe(false);
    expect(isValidEntryName("a*b")).toBe(false);
    expect(isValidEntryName("")).toBe(false);
    expect(isValidEntryName("name.")).toBe(false); // trailing dot collides on Windows
    expect(isValidEntryName("name ")).toBe(false); // trailing space
    expect(isValidEntryName("x".repeat(256))).toBe(false);
  });
});

describe("isValidMsg (webview router)", () => {
  it("accepts legitimate messages", () => {
    expect(
      isValidMsg({ c: "extSel", paths: ["a.txt", "dir/b.txt"] } as never),
    ).toBe(true);
    expect(isValidMsg({ c: "preview", path: "dir/file.txt" } as never)).toBe(true);
    expect(isValidMsg({ c: "delSel", paths: [] } as never)).toBe(true);
    expect(isValidMsg({ c: "expandDir", path: "dir" } as never)).toBe(true);
    expect(isValidMsg({ c: "pw", pw: "secret" } as never)).toBe(true);
  });

  it("rejects empty or dot paths that would wipe the extraction root", () => {
    expect(isValidMsg({ c: "delSel", paths: [""] } as never)).toBe(false);
    expect(isValidMsg({ c: "delSel", paths: ["."] } as never)).toBe(false);
    expect(isValidMsg({ c: "delSel", paths: [".."] } as never)).toBe(false);
    expect(isValidMsg({ c: "extSel", paths: ["a", ""] } as never)).toBe(false);
    expect(isValidMsg({ c: "copy", paths: [".."] } as never)).toBe(false);
    expect(isValidMsg({ c: "preview", path: "" } as never)).toBe(false);
    expect(isValidMsg({ c: "preview", path: ".." } as never)).toBe(false);
    expect(isValidMsg({ c: "renamePrompt", path: "../x" } as never)).toBe(false);
  });

  it("rejects non-string path elements and wrong types", () => {
    expect(isValidMsg({ c: "delSel", paths: [42] } as never)).toBe(false);
    expect(isValidMsg({ c: "extSel", paths: "a.txt" } as never)).toBe(false);
    expect(isValidMsg({ c: "preview", path: 7 } as never)).toBe(false);
    expect(isValidMsg({ c: "pw", pw: 7 } as never)).toBe(false);
    expect(isValidMsg({ c: "saveExpanded", paths: [null] } as never)).toBe(false);
  });
});
