/**
 * Component interaction tests — Toolbar
 */

import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Toolbar from "../components/Toolbar.vue";

function mountToolbar(overrides: Partial<Record<string, unknown>> = {}) {
  return mount(Toolbar, {
    props: {
      selectedCount: 0,
      selectedFiles: 0,
      selectedDirs: 0,
      totalFiles: 100,
      totalDirs: 20,
      sortKey: "name",
      sortAsc: true,
      searchQuery: "",
      lastAddDir: "",
      ...overrides,
    },
  });
}

describe("Toolbar", () => {
  it("renders file and dir counts", () => {
    const w = mountToolbar({ selectedFiles: 3, selectedDirs: 1 });
    const sel = w.find(".sel-count");
    expect(sel.text()).toContain("3/100");
    expect(sel.text()).toContain("1/20");
  });

  it("disables Extract and Delete when selectedCount is 0", () => {
    const w = mountToolbar({ selectedCount: 0 });
    const btns = w.findAll("button");
    const extract = btns.find((b) => b.text().includes("Extract"));
    const del = btns.find((b) => b.text().includes("Delete"));
    // The first Extract button is "Extract Selected"
    expect(extract?.attributes("disabled")).toBeDefined();
    expect(del?.attributes("disabled")).toBeDefined();
  });

  it("enables Extract and Delete when selectedCount > 0", () => {
    const w = mountToolbar({ selectedCount: 5 });
    const btns = w.findAll("button");
    const extract = btns.find((b) => b.text().includes("Extract"));
    expect(extract?.attributes("disabled")).toBeUndefined();
  });

  it("disables Delete when readOnly is true", () => {
    const w = mountToolbar({ readOnly: true });
    const btns = w.findAll("button");
    const del = btns.find((b) => b.text().includes("Delete"));
    expect(del?.attributes("disabled")).toBeDefined();
  });

  it('emits "extract-selected" on Extract button click', async () => {
    const w = mountToolbar({ selectedCount: 1 });
    const btns = w.findAll("button");
    const extract = btns.find((b) => b.text().includes("Extract"));
    await extract?.trigger("click");
    expect(w.emitted("extract-selected")).toBeTruthy();
  });

  it('emits "extract-all" on Extract All button click', async () => {
    const w = mountToolbar();
    const btns = w.findAll("button");
    const extractAll = btns.find((b) => b.text().includes("Extract All"));
    await extractAll?.trigger("click");
    expect(w.emitted("extract-all")).toBeTruthy();
  });

  it('emits "delete-selected" on Delete button click', async () => {
    const w = mountToolbar({ selectedCount: 1 });
    const btns = w.findAll("button");
    const del = btns.find((b) => b.text().includes("Delete"));
    await del?.trigger("click");
    expect(w.emitted("delete-selected")).toBeTruthy();
  });

  it('emits "search" with query on input', async () => {
    const w = mountToolbar();
    const input = w.find("input.search-input");
    await input.setValue("test");
    expect(w.emitted("search")).toBeTruthy();
    expect(w.emitted("search")![0]).toEqual(["test"]);
  });

  it('emits "sort" with "name" on Name click', async () => {
    const w = mountToolbar({ sortKey: "size" });
    const nameLabel = w.find(".sort-lbl");
    await nameLabel.trigger("click");
    expect(w.emitted("sort")).toBeTruthy();
    expect(w.emitted("sort")![0]).toEqual(["name"]);
  });

  it('emits "sort" with "size" on Size click', async () => {
    const w = mountToolbar({ sortKey: "name" });
    const labels = w.findAll(".sort-lbl");
    const sizeLabel = labels[1];
    await sizeLabel.trigger("click");
    expect(w.emitted("sort")).toBeTruthy();
    expect(w.emitted("sort")![0]).toEqual(["size"]);
  });

  it("shows sort direction indicator for active sort key", () => {
    const w = mountToolbar({ sortKey: "name", sortAsc: true });
    const nameLabel = w.find(".sort-lbl.on");
    expect(nameLabel.text()).toContain("Name");
  });

  it('emits "toggle-regex" when switching to regex mode', async () => {
    const w = mountToolbar();
    const modeBtns = w.findAll(".search-mode-btn");
    await modeBtns[1].trigger("click");
    expect(w.emitted("toggle-regex")).toBeTruthy();
  });

  it('emits "toggle-regex" when switching back to filter mode', async () => {
    const w = mountToolbar({ isRegex: true });
    const modeBtns = w.findAll(".search-mode-btn");
    await modeBtns[0].trigger("click");
    expect(w.emitted("toggle-regex")).toBeTruthy();
  });

  it("does not emit toggle-regex when clicking the active mode", async () => {
    const w = mountToolbar({ isRegex: false });
    const modeBtns = w.findAll(".search-mode-btn");
    await modeBtns[0].trigger("click");
    expect(w.emitted("toggle-regex")).toBeFalsy();
  });

  it("marks the active search mode", () => {
    const w = mountToolbar({ isRegex: true });
    const modeBtns = w.findAll(".search-mode-btn");
    expect(modeBtns[0].classes()).not.toContain("on");
    expect(modeBtns[1].classes()).toContain("on");
  });

  it('emits "search" with empty query on clear button click', async () => {
    const w = mountToolbar({ searchQuery: "test" });
    await w.find(".search-clear").trigger("click");
    expect(w.emitted("search")).toBeTruthy();
    expect(w.emitted("search")![0]).toEqual([""]);
  });

  it('emits "search" with empty query on Esc', async () => {
    const w = mountToolbar({ searchQuery: "test" });
    await w.find("input.search-input").trigger("keydown", { key: "Escape" });
    expect(w.emitted("search")).toBeTruthy();
    expect(w.emitted("search")![0]).toEqual([""]);
  });

  it("marks the search box with error state and shows the message", () => {
    const w = mountToolbar({ searchQuery: "(", regexError: "Invalid pattern" });
    expect(w.find(".search-box").classes()).toContain("search-error");
    expect(w.find(".search-error-msg").text()).toBe("Invalid pattern");
  });

  it("marks the search box as active while a query is set", () => {
    const w = mountToolbar({ searchQuery: "test" });
    expect(w.find(".search-box").classes()).toContain("search-on");
    const w2 = mountToolbar();
    expect(w2.find(".search-box").classes()).not.toContain("search-on");
  });

  it('emits "expand-all" and "collapse-all"', async () => {
    const w = mountToolbar();
    const btns = w.findAll("button.btn-ico");
    const expandAll = btns.find((b) => b.find(".codicon-expand-all").exists());
    const collapseAll = btns.find((b) => b.find(".codicon-collapse-all").exists());
    await expandAll?.trigger("click");
    await collapseAll?.trigger("click");
    expect(w.emitted("expand-all")).toBeTruthy();
    expect(w.emitted("collapse-all")).toBeTruthy();
  });

  it('emits "convert" on Convert button click', async () => {
    const w = mountToolbar();
    const btns = w.findAll("button.btn");
    const convert = btns.find((b) => b.text().includes("Convert"));
    await convert?.trigger("click");
    expect(w.emitted("convert")).toBeTruthy();
  });
});
