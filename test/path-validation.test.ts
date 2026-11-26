/**
 * Path/name validation tests — Smart Archiver VSCode Extension
 *
 * Locks the webview defense-in-depth whitelist: entry paths and entry names
 * that reach filesystem operations must never be "", ".", "..", host-absolute,
 * or carry native separators. These are the guards that turn a crafted
 * webview message into a no-op instead of a deleted archive tree. The one
 * tolerated absolute shape is a drive prefix ("C:", "C:/…"): archives can
 * legitimately store entry names that way, and each disk sink confines it.
 *
 * @module test/path-validation
 */

import { describe, it, expect } from "vitest";
import { isValidArchivePath, isValidEntryName } from "../src/utils/security";
import { isValidMsg } from "../src/providers/webview/router";
import { parse7zListing } from "../src/utils/parse7z";
import { buildTreeRootOnly, getDirChildren } from "../src/providers/treeBuilder";
import type { FlatEntry, TreeNode } from "../src/providers/treeBuilder";

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

  it("rejects absolute paths that are not drive-prefixed", () => {
    expect(isValidArchivePath("/etc/passwd")).toBe(false);
    expect(isValidArchivePath("//server/share")).toBe(false);
    expect(isValidArchivePath("c:\\windows")).toBe(false);
  });

  it("accepts entry names stored absolute (drive prefix)", () => {
    // WinRAR `-ep2` (and some ZIP writers) store full paths, so the viewer
    // has to expand "C:" and preview "C:/…/file" instead of dropping them.
    expect(isValidArchivePath("C:")).toBe(true);
    expect(isValidArchivePath("C:/")).toBe(true);
    expect(isValidArchivePath("C:/Users/admin/AppData/Local/Temp/corpus/app.dll")).toBe(true);
    expect(isValidArchivePath("d:/dir/file.txt")).toBe(true);
    // The relative-shape tolerances still hold behind the drive.
    expect(isValidArchivePath("C:/dir/")).toBe(true);
    expect(isValidArchivePath("C:/./dir")).toBe(true);
    // Drive-relative (no separator) is not a shape entry listings produce.
    expect(isValidArchivePath("C:file.txt")).toBe(false);
  });

  it("still rejects traversal behind a drive prefix", () => {
    expect(isValidArchivePath("C:/../etc/passwd")).toBe(false);
    expect(isValidArchivePath("C:/dir/../../x")).toBe(false);
    expect(isValidArchivePath("C://x")).toBe(false);
    expect(isValidArchivePath("C:\\Users\\x")).toBe(false);
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
    expect(isValidEntryName("CON")).toBe(false); // Windows device name
    expect(isValidEntryName("com1.log")).toBe(false); // device name with extension
    expect(isValidEntryName("bad\u0001name")).toBe(false); // control character
  });
});

describe("isValidMsg (webview router)", () => {
  it("accepts legitimate messages", () => {
    expect(isValidMsg({ c: "extSel", paths: ["a.txt", "dir/b.txt"] } as never)).toBe(true);
    expect(isValidMsg({ c: "preview", path: "dir/file.txt" } as never)).toBe(true);
    expect(isValidMsg({ c: "delSel", paths: [] } as never)).toBe(true);
    expect(isValidMsg({ c: "expandDir", path: "dir" } as never)).toBe(true);
    expect(isValidMsg({ c: "pw", pw: "secret" } as never)).toBe(true);
  });

  it("accepts messages for members stored with an absolute name", () => {
    // Archives that store full paths (WinRAR `-ep2`) list a bare "C:" root
    // node — expandDir/preview/extSel for those must reach their handlers
    // instead of being dropped by the gate.
    expect(isValidMsg({ c: "expandDir", path: "C:" } as never)).toBe(true);
    expect(isValidMsg({ c: "preview", path: "C:/Users/x/app.dll" } as never)).toBe(true);
    expect(isValidMsg({ c: "extSel", paths: ["C:/Users/x/app.dll"] } as never)).toBe(true);
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

  it("validates excludes and flat on extractSelected", () => {
    expect(
      isValidMsg({ c: "extSel", paths: ["a.txt"], excludes: ["dir/b.txt"], flat: true } as never),
    ).toBe(true);
    expect(isValidMsg({ c: "extSel", paths: ["a.txt"], excludes: ["../x"] } as never)).toBe(false);
    expect(isValidMsg({ c: "extSel", paths: ["a.txt"], excludes: "dir" } as never)).toBe(false);
    expect(isValidMsg({ c: "extSel", paths: ["a.txt"], excludes: [42] } as never)).toBe(false);
    expect(isValidMsg({ c: "extSel", paths: ["a.txt"], flat: "yes" } as never)).toBe(false);
  });
});

describe("members stored with an absolute name", () => {
  // `7z l -slt` output for an archive whose entries carry a full path
  // (WinRAR `-ep2`): the tree's root node is the bare "C:" directory, and
  // every member path is that node plus the rest — the shapes the viewer
  // sends back for expandDir/preview/extSel.
  const stdout = [
    "Path = C:\\Users\\admin\\AppData\\Local\\Temp\\corpus",
    "Size = 0",
    "Attributes = D",
    "",
    "Path = C:\\Users\\admin\\AppData\\Local\\Temp\\corpus\\app.dll",
    "Size = 1024",
    "Attributes = A",
    "",
  ].join("\n");

  function expandAll(nodes: TreeNode[], entries: FlatEntry[]): void {
    for (const n of nodes) {
      if (n.kind !== "DIRECTORY") continue;
      n.children = getDirChildren(n.path, entries);
      expandAll(n.children, entries);
    }
  }

  it("expands and previews through the gate instead of being dropped", () => {
    const entries = parse7zListing(stdout, "abs.rar");
    expect(entries.map((e) => e.path)).toEqual([
      "C:\\Users\\admin\\AppData\\Local\\Temp\\corpus",
      "C:\\Users\\admin\\AppData\\Local\\Temp\\corpus\\app.dll",
    ]);

    // The tree normalizes to "/" separators; that normalized shape is what
    // the webview posts back.
    const root = buildTreeRootOnly(entries, "abs.rar");
    expect(root.map((n) => n.path)).toEqual(["C:"]);
    expandAll(root, entries);

    const flat: TreeNode[] = [];
    const collect = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        flat.push(n);
        collect(n.children ?? []);
      }
    };
    collect(root);

    const file = flat.find((n) => n.path.endsWith("/app.dll"))!;
    expect(file.path).toBe("C:/Users/admin/AppData/Local/Temp/corpus/app.dll");
    const corpus = flat.find((n) => n.kind === "DIRECTORY" && n.path.endsWith("/corpus"))!;
    expect(corpus.path).toBe("C:/Users/admin/AppData/Local/Temp/corpus");

    expect(isValidMsg({ c: "expandDir", path: root[0].path } as never)).toBe(true);
    expect(isValidMsg({ c: "expandDir", path: corpus.path } as never)).toBe(true);
    expect(isValidMsg({ c: "preview", path: file.path } as never)).toBe(true);
    expect(isValidMsg({ c: "extSel", paths: [file.path] } as never)).toBe(true);
  });
});
