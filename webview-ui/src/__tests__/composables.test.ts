/**
 * Composable pure-logic tests — Smart Archive VSCode Extension (webview UI)
 *
 * Tests for pure utility functions extracted from Vue composables:
 * - fuzzyMatch / isRedosSafe / collectMatches (useSearch)
 * - dedupPaths (useSelection)
 * - buildNodeMap (useTree)
 */

import { describe, it, expect } from "vitest";
import type { TreeNodeData } from "../types";
import {
  fuzzyMatch,
  isRedosSafe,
  collectMatches,
  segmentHighlight,
} from "../composables/useSearch";
import { dedupPaths } from "../composables/useSelection";
import { buildNodeMap } from "../composables/useTree";
import { useSort } from "../composables/useSort";

function node(name: string, children?: TreeNodeData[]): TreeNodeData {
  return {
    name,
    path: name,
    size: 0,
    kind: children ? "DIRECTORY" : "REGULAR_FILE",
    children,
  };
}

describe("fuzzyMatch", () => {
  it("matches exact string", () => {
    expect(fuzzyMatch("hello", "hello")).toBe(true);
  });

  it("matches subsequence", () => {
    expect(fuzzyMatch("hello.txt", "hlo")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(fuzzyMatch("Hello", "hello")).toBe(false);
  });

  it("empty query matches everything", () => {
    expect(fuzzyMatch("anything", "")).toBe(true);
  });

  it("query longer than string fails", () => {
    expect(fuzzyMatch("hi", "hello")).toBe(false);
  });

  it("matches at the end", () => {
    expect(fuzzyMatch("archive.zip", "zip")).toBe(true);
  });

  it("does not match non-subsequence", () => {
    expect(fuzzyMatch("abc", "cba")).toBe(false);
  });

  it("handles empty string", () => {
    expect(fuzzyMatch("", "")).toBe(true);
    expect(fuzzyMatch("", "a")).toBe(false);
  });
});

describe("isRedosSafe", () => {
  it("safe patterns pass", () => {
    expect(isRedosSafe("hello")).toBe(true);
    expect(isRedosSafe("[a-z]+")).toBe(true);
    expect(isRedosSafe("\\d{4}")).toBe(true);
    expect(isRedosSafe("foo|bar")).toBe(true);
  });

  it("nested quantifiers are blocked", () => {
    expect(isRedosSafe("(a+)+*")).toBe(false);
    expect(isRedosSafe("(a*){1,}+")).toBe(false);
    expect(isRedosSafe("(.*)*")).toBe(false);
  });

  it("consecutive quantifiers are blocked", () => {
    expect(isRedosSafe("a++")).toBe(false);
    expect(isRedosSafe("a**")).toBe(false);
  });

  it("long patterns are blocked", () => {
    expect(isRedosSafe("a".repeat(201))).toBe(false);
    expect(isRedosSafe("a".repeat(200))).toBe(true);
  });

  it("double-plus patterns blocked", () => {
    expect(isRedosSafe("\\d++")).toBe(false);
    expect(isRedosSafe("\\w+ +")).toBe(false);
  });
});

describe("collectMatches", () => {
  const nodes: TreeNodeData[] = [
    {
      name: "src",
      path: "src",
      size: 0,
      kind: "DIRECTORY",
      children: [
        { name: "index.ts", path: "src/index.ts", size: 100, kind: "REGULAR_FILE" },
        { name: "utils.ts", path: "src/utils.ts", size: 200, kind: "REGULAR_FILE" },
        {
          name: "lib",
          path: "src/lib",
          size: 0,
          kind: "DIRECTORY",
          children: [
            { name: "helper.ts", path: "src/lib/helper.ts", size: 50, kind: "REGULAR_FILE" },
          ],
        },
        {
          name: "empty",
          path: "src/empty",
          size: 0,
          kind: "DIRECTORY",
          children: [],
        },
      ],
    },
    { name: "README.md", path: "README.md", size: 500, kind: "REGULAR_FILE" },
  ];

  it("exact name match includes parents", () => {
    const out = new Set<string>();
    const directOut = new Set<string>();
    collectMatches(nodes, /^index\.ts$/, null, out, directOut);
    expect(directOut.has("src/index.ts")).toBe(true);
    expect(out.has("src/index.ts")).toBe(true);
    // parent should be included for tree visibility
    expect(out.has("src")).toBe(true);
  });

  it("partial name match with regex", () => {
    const out = new Set<string>();
    const directOut = new Set<string>();
    collectMatches(nodes, /\.ts$/, null, out, directOut);
    expect(directOut.has("src/index.ts")).toBe(true);
    expect(directOut.has("src/utils.ts")).toBe(true);
    expect(directOut.has("src/lib/helper.ts")).toBe(true);
  });

  it("fuzzy match by name substring", () => {
    const out = new Set<string>();
    const directOut = new Set<string>();
    collectMatches(nodes, null, "readme", out, directOut);
    expect(directOut.has("README.md")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    const out = new Set<string>();
    const directOut = new Set<string>();
    const hit = collectMatches(nodes, /^nonexistent$/, null, out, directOut);
    expect(hit).toBe(false);
    expect(out.size).toBe(0);
  });

  it("empty nodes array returns false", () => {
    const out = new Set<string>();
    const directOut = new Set<string>();
    const hit = collectMatches([], /a/, null, out, directOut);
    expect(hit).toBe(false);
  });

  it("empty directory with matching ancestors does not include it", () => {
    const out = new Set<string>();
    const directOut = new Set<string>();
    // The empty dir "src/empty" has no children that match, so it should not be included
    collectMatches(nodes, /^helper\.ts$/, null, out, directOut);
    expect(directOut.has("src/lib/helper.ts")).toBe(true);
    expect(out.has("src/empty")).toBe(false);
  });
});

describe("segmentHighlight", () => {
  it("returns a single plain segment without a query", () => {
    expect(segmentHighlight("readme.md", "")).toEqual([{ text: "readme.md", mark: false }]);
    expect(segmentHighlight("readme.md", "   ")).toEqual([{ text: "readme.md", mark: false }]);
  });

  it("marks fuzzy-matched characters individually", () => {
    expect(segmentHighlight("hello.txt", "hlo")).toEqual([
      { text: "h", mark: true },
      { text: "e", mark: false },
      { text: "l", mark: true },
      { text: "l", mark: false },
      { text: "o", mark: true },
      { text: ".txt", mark: false },
    ]);
  });

  it("matches case-insensitively but preserves original casing", () => {
    expect(segmentHighlight("Readme.MD", "readme")).toEqual([
      { text: "R", mark: true },
      { text: "e", mark: true },
      { text: "a", mark: true },
      { text: "d", mark: true },
      { text: "m", mark: true },
      { text: "e", mark: true },
      { text: ".MD", mark: false },
    ]);
  });

  it("returns plain when no fuzzy match", () => {
    expect(segmentHighlight("abc.txt", "qqq")).toEqual([{ text: "abc.txt", mark: false }]);
  });

  it("highlights regex matches inside /.../ delimiters", () => {
    expect(segmentHighlight("build-v2.zip", "/\\d+/")).toEqual([
      { text: "build-v", mark: false },
      { text: "2", mark: true },
      { text: ".zip", mark: false },
    ]);
  });

  it("blocks ReDoS-unsafe highlight patterns instead of highlighting", () => {
    expect(segmentHighlight("aaa.txt", "/(a+)+*/")).toEqual([{ text: "aaa.txt", mark: false }]);
    expect(segmentHighlight("aaa.txt", "/\\d++/")).toEqual([{ text: "aaa.txt", mark: false }]);
  });

  it("handles invalid regex gracefully", () => {
    expect(segmentHighlight("aaa.txt", "/([/")).toEqual([{ text: "aaa.txt", mark: false }]);
  });

  it("handles zero-width regex matches without hanging", () => {
    const segs = segmentHighlight("abc", "/(?:)/");
    expect(segs.every((s) => !s.mark || s.text === "")).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe("abc");
  });
});

describe("dedupPaths", () => {
  it("returns empty for empty set", () => {
    expect(dedupPaths(new Set())).toEqual([]);
  });

  it("keeps top-level paths", () => {
    const s = new Set(["a", "b", "c"]);
    expect(dedupPaths(s).sort()).toEqual(["a", "b", "c"]);
  });

  it("deduplicates child when parent is selected", () => {
    const s = new Set(["a", "a/b", "a/c"]);
    expect(dedupPaths(s)).toEqual(["a"]);
  });

  it("keeps grandchild when parent is not selected", () => {
    const s = new Set(["a/b/c", "a/d"]);
    expect(dedupPaths(s).sort()).toEqual(["a/b/c", "a/d"]);
  });

  it("handles deeply nested selection", () => {
    const s = new Set(["a", "a/b/c/d", "a/b/c/e"]);
    expect(dedupPaths(s).sort()).toEqual(["a"]);
  });

  it("keeps siblings when parent not selected", () => {
    const s = new Set(["x/y", "x/z"]);
    expect(dedupPaths(s).sort()).toEqual(["x/y", "x/z"]);
  });

  it("handles paths with directory-like naming", () => {
    const s = new Set(["doc", "doc/readme"]);
    // doc/readme is covered by doc (since doc is a prefix ancestor)
    expect(dedupPaths(s)).toEqual(["doc"]);
  });

  it("handles single path", () => {
    expect(dedupPaths(new Set(["a/b/c"]))).toEqual(["a/b/c"]);
  });
});

describe("buildNodeMap", () => {
  it("builds map from flat list", () => {
    const nodes: TreeNodeData[] = [node("a"), node("b")];
    const map = buildNodeMap(nodes);
    expect(map.size).toBe(2);
    expect(map.get("a")?.name).toBe("a");
    expect(map.get("b")?.name).toBe("b");
  });

  it("indexes nested children", () => {
    const child: TreeNodeData = { name: "child", path: "a/child", size: 10, kind: "REGULAR_FILE" };
    const parent = node("a", [child]);
    const map = buildNodeMap([parent]);
    expect(map.size).toBe(2);
    expect(map.get("a")?.name).toBe("a");
    expect(map.get("a/child")?.name).toBe("child");
  });

  it("handles empty tree", () => {
    const map = buildNodeMap([]);
    expect(map.size).toBe(0);
  });

  it("deeply nested", () => {
    const leaf: TreeNodeData = { name: "leaf", path: "a/b/c/leaf", size: 1, kind: "REGULAR_FILE" };
    const c = node("c", [leaf]);
    const b = node("b", [c]);
    const a = node("a", [b]);
    const map = buildNodeMap([a]);
    expect(map.size).toBe(4);
    expect(map.get("a/b/c/leaf")?.name).toBe("leaf");
  });

  it("sibling nodes all indexed", () => {
    const children: TreeNodeData[] = [
      { name: "a", path: "dir/a", size: 1, kind: "REGULAR_FILE" },
      { name: "b", path: "dir/b", size: 2, kind: "REGULAR_FILE" },
      { name: "c", path: "dir/c", size: 3, kind: "REGULAR_FILE" },
    ];
    const parent = node("dir", children);
    const map = buildNodeMap([parent]);
    expect(map.size).toBe(4);
    expect(map.get("dir/a")).toBeDefined();
    expect(map.get("dir/b")).toBeDefined();
    expect(map.get("dir/c")).toBeDefined();
  });
});

describe("useSort.sortNodes", () => {
  const f = (name: string, size = 0): TreeNodeData => ({
    name,
    path: name,
    size,
    kind: "REGULAR_FILE",
  });
  const d = (name: string, children?: TreeNodeData[]): TreeNodeData => ({
    name,
    path: name,
    size: 0,
    kind: "DIRECTORY",
    children,
  });

  it("sorts by name ascending (default)", () => {
    const sort = useSort();
    const result = sort.sortNodes([f("c"), f("a"), f("b")]);
    expect(result.map((n) => n.name)).toEqual(["a", "b", "c"]);
  });

  it("sorts by name descending", () => {
    const sort = useSort();
    sort.setSort("name"); // sortKey is already "name", so this toggles asc→desc
    expect(sort.sortAsc.value).toBe(false);
    const result = sort.sortNodes([f("a"), f("c"), f("b")]);
    expect(result.map((n) => n.name)).toEqual(["c", "b", "a"]);
  });

  it("sorts by size ascending", () => {
    const sort = useSort();
    sort.setSort("size");
    const result = sort.sortNodes([f("b", 300), f("a", 100), f("c", 200)]);
    expect(result.map((n) => n.name)).toEqual(["a", "c", "b"]);
  });

  it("sorts by size descending", () => {
    const sort = useSort();
    sort.setSort("size");
    sort.setSort("size"); // toggle to desc
    expect(sort.sortAsc.value).toBe(false);
    const result = sort.sortNodes([f("a", 100), f("c", 200), f("b", 300)]);
    expect(result.map((n) => n.name)).toEqual(["b", "c", "a"]);
  });

  it("directories always come before files", () => {
    const sort = useSort();
    const result = sort.sortNodes([f("z"), d("a"), f("m")]);
    expect(result.map((n) => n.name)).toEqual(["a", "m", "z"]);
  });

  it("directories sorted among themselves, then files", () => {
    const sort = useSort();
    const result = sort.sortNodes([f("z"), d("c"), f("a"), d("b")]);
    expect(result.map((n) => n.name)).toEqual(["b", "c", "a", "z"]);
  });

  it("recursively sorts children", () => {
    const sort = useSort();
    const result = sort.sortNodes([d("parent", [f("c"), f("a"), f("b")])]);
    expect(result[0].children?.map((n) => n.name)).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty input", () => {
    const sort = useSort();
    expect(sort.sortNodes([])).toEqual([]);
  });

  it("does not mutate original array", () => {
    const sort = useSort();
    const original = [f("b"), f("a")];
    const result = sort.sortNodes(original);
    expect(original.map((n) => n.name)).toEqual(["b", "a"]);
    expect(result.map((n) => n.name)).toEqual(["a", "b"]);
  });

  it("same-name items maintain stable order", () => {
    const sort = useSort();
    const result = sort.sortNodes([f("a"), f("a")]);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("a");
  });
});
