/**
 * Component interaction tests — SearchResults (flat search result list)
 */

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import SearchResults from "../components/SearchResults.vue";
import type { FlatNode } from "../types";

// The real virtualizer measures the scroll container; jsdom has no layout,
// so it renders nothing. Provide a stub that yields every row.
vi.mock("@tanstack/vue-virtual", async () => {
  const { ref } = await import("vue");
  return {
    useVirtualizer: (opts: { value: { count: number } }) => {
      const { count } = opts.value;
      const items = Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 30,
        size: 30,
      }));
      return ref({
        getTotalSize: () => count * 30,
        getVirtualItems: () => items,
        scrollToIndex: () => {},
      });
    },
  };
});

function flatNode(
  name: string,
  path: string,
  kind: "DIRECTORY" | "REGULAR_FILE",
  size = 0,
  hasChildren = kind === "DIRECTORY",
): FlatNode {
  return {
    node: { name, path, size, kind, children: kind === "DIRECTORY" ? [] : undefined },
    depth: path.split("/").length - 1,
    path,
    expanded: false,
    hasChildren,
    visible: true,
    inheritCollapsed: false,
  };
}

function mountResults(overrides: Partial<Record<string, unknown>> = {}) {
  return mount(SearchResults, {
    props: {
      flatNodes: [
        flatNode("index.ts", "src/index.ts", "REGULAR_FILE", 100),
        flatNode("lib", "src/lib", "DIRECTORY"),
        flatNode("README.md", "README.md", "REGULAR_FILE", 500),
      ],
      selected: new Set<string>(),
      searchQuery: "index",
      loadingPaths: new Set<string>(),
      descCounts: {},
      ...overrides,
    },
  });
}

describe("SearchResults", () => {
  it("renders one row per matched entry", () => {
    const w = mountResults();
    const rows = w.findAll(".row-res");
    expect(rows.length).toBe(3);
  });

  it("shows the name and a path crumb for nested entries", () => {
    const w = mountResults();
    const row = w.findAll(".row-res")[0];
    expect(row.find(".name").text()).toBe("index.ts");
    expect(row.find(".res-crumb").text()).toBe("src/");
  });

  it("omits the crumb for root-level entries", () => {
    const w = mountResults();
    const row = w.findAll(".row-res")[2];
    expect(row.find(".name").text()).toBe("README.md");
    expect(row.find(".res-crumb").exists()).toBe(false);
  });

  it("highlights query segments in the name", () => {
    const w = mountResults();
    const marks = w.findAll(".row-res")[0].findAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((m) => m.text()).join("")).toBe("index");
  });

  it("emits row-click with path and modifiers", async () => {
    const w = mountResults();
    const row = w.findAll(".row-res")[1];
    await row.trigger("click", { shiftKey: true });
    expect(w.emitted("row-click")).toBeTruthy();
    expect(w.emitted("row-click")![0]).toEqual(["src/lib", true, true, false]);
  });

  it("emits row-dblclick for files", async () => {
    const w = mountResults();
    await w.findAll(".row-res")[0].trigger("dblclick");
    expect(w.emitted("row-dblclick")).toBeTruthy();
    expect(w.emitted("row-dblclick")![0]).toEqual(["src/index.ts", false]);
  });

  it("emits check-click on the checkbox", async () => {
    const w = mountResults();
    await w.findAll(".row-res")[0].find(".checkbox").trigger("click");
    expect(w.emitted("check-click")).toBeTruthy();
    expect(w.emitted("check-click")![0]).toEqual(["src/index.ts"]);
  });

  it("emits context-menu with the parent dir path", async () => {
    const w = mountResults();
    const row = w.findAll(".row-res")[0];
    await row.trigger("contextmenu", { clientX: 10, clientY: 20 });
    expect(w.emitted("context-menu")).toBeTruthy();
    const args = w.emitted("context-menu")![0] as unknown[];
    expect(args[1]).toBe("src/index.ts");
    expect(args[2]).toBe("src");
  });

  it("marks selected rows", () => {
    const w = mountResults({ selected: new Set(["src/lib"]) });
    const rows = w.findAll(".row-res");
    expect(rows[0].classes()).not.toContain("sel");
    expect(rows[1].classes()).toContain("sel");
  });

  it("shows size for files and desc counts for dirs", () => {
    const w = mountResults({
      descCounts: { "src/lib": { files: 3, dirs: 1, size: 42 } },
    });
    const rows = w.findAll(".row-res");
    expect(rows[0].find(".size").text()).toBe("100 B");
    expect(rows[1].find(".desc-count").text()).toContain("3");
  });

  it("emits expand from a folder row's chevron", async () => {
    const w = mountResults();
    const dirRow = w.findAll(".row-res")[1];
    expect(dirRow.find(".arrow .codicon").exists()).toBe(true);
    await dirRow.find(".arrow").trigger("click");
    expect(w.emitted("expand")).toBeTruthy();
    expect(w.emitted("expand")![0]).toEqual(["src/lib"]);
  });

  it("shows a spinner while a matched folder is loading", () => {
    const w = mountResults({ loadingPaths: new Set(["src/lib"]) });
    const dirRow = w.findAll(".row-res")[1];
    expect(dirRow.find(".arrow .spinner-sm").exists()).toBe(true);
  });

  it("rotates the chevron for expanded folders and indents children", () => {
    const lib = flatNode("lib", "src/lib", "DIRECTORY");
    const helper = flatNode("helper.ts", "src/lib/helper.ts", "REGULAR_FILE", 10);
    const expanded = { ...lib, expanded: true };
    const w = mountResults({ flatNodes: [expanded, helper] });
    const rows = w.findAll(".row-res");
    expect(rows[0].find(".arrow").classes()).toContain("rot");
    expect(rows[0].attributes("aria-expanded")).toBe("true");
    expect(rows[1].attributes("style")).toContain("padding-left: 36px");
  });
});
