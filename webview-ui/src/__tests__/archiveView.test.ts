/**
 * Archive-view controller tests — the internal seams behind useArchiveView.
 *
 * Exercises host ops, message dispatch, and keyboard navigation against real
 * tree/selection controllers with a fake post bus, without mounting Vue.
 */

import { describe, it, expect, vi } from "vitest";
import { ref, computed } from "vue";
import type { TreeNodeData, FlatNode } from "../types";
import { useSelection } from "../composables/useSelection";
import { useTreeFlatten } from "../composables/useTree";
import { createHostOps } from "../composables/archiveOps";
import { createMessageDispatcher } from "../composables/messageDispatcher";
import { createKeyboardNav, computeNavigationTarget } from "../composables/keyboardNav";
import { useArchiveView } from "../composables/useArchiveView";

function makeTree(): TreeNodeData[] {
  return [
    {
      name: "dir",
      path: "dir",
      size: 0,
      kind: "DIRECTORY",
      children: [
        { name: "a.txt", path: "dir/a.txt", size: 10, kind: "REGULAR_FILE" },
        { name: "b.txt", path: "dir/b.txt", size: 20, kind: "REGULAR_FILE" },
        {
          name: "sub",
          path: "dir/sub",
          size: 0,
          kind: "DIRECTORY",
          children: [],
          hasMore: true,
        },
      ],
    },
    { name: "c.txt", path: "c.txt", size: 5, kind: "REGULAR_FILE" },
  ];
}

function makeFixture() {
  const treeData = ref<TreeNodeData[]>(makeTree());
  const selection = useSelection();
  const tree = useTreeFlatten(treeData);
  tree.expandedPaths.value.add("dir");
  const visibleFlatNodes = computed<FlatNode[]>(() => tree.flatNodes.value);
  const post = vi.fn();
  const onMessage = vi.fn(() => vi.fn());
  const viewState = ref("content");
  const loadingMsg = ref("");
  const pwError = ref(false);
  const isEncrypted = ref(false);
  const selectAllPending = ref(false);
  const scrollToPath = vi.fn();
  const containerEl = ref<HTMLElement | null>(null);
  const showToast = vi.fn();
  return {
    treeData,
    selection,
    tree,
    visibleFlatNodes,
    post,
    onMessage,
    viewState,
    loadingMsg,
    pwError,
    isEncrypted,
    selectAllPending,
    scrollToPath,
    containerEl,
    showToast,
  };
}

describe("computeNavigationTarget", () => {
  const flat: FlatNode[] = [
    {
      node: makeTree()[0],
      depth: 0,
      path: "dir",
      expanded: true,
      hasChildren: true,
      visible: true,
      inheritCollapsed: false,
    },
    {
      node: makeTree()[0].children![0],
      depth: 1,
      path: "dir/a.txt",
      expanded: false,
      hasChildren: false,
      visible: true,
      inheritCollapsed: false,
    },
    {
      node: makeTree()[1],
      depth: 0,
      path: "c.txt",
      expanded: false,
      hasChildren: false,
      visible: true,
      inheritCollapsed: false,
    },
  ];

  it("moves down from anchor", () => {
    const t = computeNavigationTarget(flat, "dir", 1);
    expect(t?.path).toBe("dir/a.txt");
  });

  it("moves up", () => {
    const t = computeNavigationTarget(flat, "dir/a.txt", -1);
    expect(t?.path).toBe("dir");
  });

  it("starts from top when no anchor and moving down", () => {
    const t = computeNavigationTarget(flat, null, 1);
    expect(t?.path).toBe("dir");
  });

  it("starts from bottom when no anchor and moving up", () => {
    const t = computeNavigationTarget(flat, null, -1);
    expect(t?.path).toBe("c.txt");
  });

  it("clamps past the end", () => {
    const t = computeNavigationTarget(flat, "c.txt", 5);
    expect(t?.idx).toBe(2);
  });

  it("returns null for empty list", () => {
    expect(computeNavigationTarget([], null, 1)).toBeNull();
  });
});

describe("createHostOps", () => {
  it("extAll posts the command and toasts", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    ops.extAll();
    expect(f.post).toHaveBeenCalledWith({ c: "extAll" });
    expect(f.showToast).toHaveBeenCalledWith("Extracting all files...", true);
  });

  it("extSel posts effective paths and flat=true when no dir selected", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    f.selection.toggle("dir/a.txt");
    f.selection.toggle("dir/b.txt");
    ops.extSel();
    expect(f.post).toHaveBeenCalledWith({
      c: "extSel",
      paths: ["dir/a.txt", "dir/b.txt"],
      excludes: [],
      flat: true,
    });
  });

  it("extSel posts flat=false when a dir is selected", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    f.selection.toggle("dir");
    ops.extSel();
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ c: "extSel", flat: false }));
  });

  it("extSel does nothing with empty selection", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    ops.extSel();
    expect(f.post).not.toHaveBeenCalled();
  });

  it("delSel switches to loading view", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    f.selection.toggle("dir/a.txt");
    ops.delSel();
    expect(f.post).toHaveBeenCalledWith({ c: "delSel", paths: ["dir/a.txt"] });
    expect(f.viewState.value).toBe("loading");
    expect(f.loadingMsg.value).toContain("Deleting");
  });

  it("copySel posts deduped paths and flat flag", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    f.selection.toggle("dir");
    f.selection.toggle("dir/a.txt");
    ops.copySel();
    expect(f.post).toHaveBeenCalledWith({ c: "copy", paths: ["dir"], flat: false });
  });

  it("addFiles uses lastAddDir", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    f.selection.toggle("dir", true);
    ops.addFiles();
    expect(f.post).toHaveBeenCalledWith({ c: "addFiles", dir: "dir" });
  });

  it("newFolder prefers lastAddDir over context-menu dir", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "dir/sub" });
    f.selection.toggle("dir/a.txt");
    ops.newFolder();
    expect(f.post).toHaveBeenCalledWith({ c: "newFolderPrompt", dir: "dir" });
  });

  it("newFolder falls back to context-menu dir", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "dir/sub" });
    ops.newFolder();
    expect(f.post).toHaveBeenCalledWith({ c: "newFolderPrompt", dir: "dir/sub" });
  });

  it("submitPassword clears pwError and posts pw", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    f.pwError.value = true;
    ops.submitPassword("secret");
    expect(f.pwError.value).toBe(false);
    expect(f.post).toHaveBeenCalledWith({ c: "pw", pw: "secret" });
  });

  it("getEffectivePaths excludes unselected children of a partially selected dir", () => {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    f.selection.toggle("dir");
    f.selection.toggle("dir/a.txt");
    const { paths, excludes } = ops.getEffectivePaths();
    expect(paths).toContain("dir");
    expect(excludes).toContain("dir/b.txt");
  });
});

describe("createMessageDispatcher", () => {
  it("ok toasts and returns to content view", () => {
    const f = makeFixture();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({ c: "ok", t: "Done" });
    expect(f.showToast).toHaveBeenCalledWith("Done", true);
    expect(f.viewState.value).toBe("content");
  });

  it("err toasts as failure and returns to content view", () => {
    const f = makeFixture();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({ c: "err", t: "Boom" });
    expect(f.showToast).toHaveBeenCalledWith("Boom", false);
    expect(f.viewState.value).toBe("content");
  });

  it("loading with a string message switches to loading view", () => {
    const f = makeFixture();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({ c: "loading", t: "Repacking..." });
    expect(f.viewState.value).toBe("loading");
    expect(f.loadingMsg.value).toBe("Repacking...");
  });

  it("loading true/false toggles between loading and content", () => {
    const f = makeFixture();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({ c: "loading", t: true });
    expect(f.viewState.value).toBe("loading");
    d.handleMessage({ c: "loading", t: false });
    expect(f.viewState.value).toBe("content");
  });

  it("pwerr sets the password error flag", () => {
    const f = makeFixture();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({ c: "pwerr", t: "Wrong password" });
    expect(f.pwError.value).toBe(true);
  });

  it("encState updates encryption state", () => {
    const f = makeFixture();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({ c: "encState", v: true });
    expect(f.isEncrypted.value).toBe(true);
  });

  it("dirChildren inserts children and extends selection when parent selected", () => {
    const f = makeFixture();
    const loadExpanded = vi.fn();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: loadExpanded });
    f.selection.toggle("dir/sub");
    d.handleMessage({
      c: "dirChildren",
      path: "dir/sub",
      children: [{ name: "x.txt", path: "dir/sub/x.txt", size: 1, kind: "REGULAR_FILE" }],
    });
    const node = f.tree.findNode("dir/sub");
    expect(node?.children?.length).toBe(1);
    expect(f.selection.state.selected.has("dir/sub/x.txt")).toBe(true);
    expect(loadExpanded).toHaveBeenCalled();
  });

  it("dirChildren auto-expands matching children", () => {
    const f = makeFixture();
    f.tree.initExpandedFromTree();
    f.tree.expandedPaths.value.delete("dir/sub");
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({
      c: "dirChildren",
      path: "dir/sub",
      children: [
        { name: "y", path: "dir/sub/y", size: 0, kind: "DIRECTORY", children: [], hasMore: true },
      ],
    });
    expect(f.tree.expandedPaths.value.has("dir/sub/y")).toBe(true);
  });
});

describe("createKeyboardNav", () => {
  function makeKeyboard() {
    const f = makeFixture();
    const ops = createHostOps({ ...f, getCtxDir: () => "" });
    const closeContextMenu = vi.fn();
    const keyboard = createKeyboardNav({
      visibleFlatNodes: f.visibleFlatNodes,
      selection: f.selection,
      tree: f.tree,
      post: f.post,
      scrollToPath: f.scrollToPath,
      containerEl: f.containerEl,
      closeContextMenu,
      expandAllAndLoad: vi.fn(),
      selectAllPending: f.selectAllPending,
      ops,
    });
    return { ...f, keyboard, closeContextMenu };
  }

  it("ArrowDown selects the next row and scrolls to it", () => {
    const f = makeKeyboard();
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(f.selection.state.selected.has("dir")).toBe(true);
    expect(f.selection.state.anchorPath).toBe("dir");
    expect(f.scrollToPath).toHaveBeenCalledWith("dir");

    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(f.selection.state.selected.has("dir/a.txt")).toBe(true);
  });

  it("Shift+ArrowDown extends selection without clearing", () => {
    const f = makeKeyboard();
    f.selection.toggle("dir");
    f.selection.state.anchorPath = "dir";
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true }));
    expect(f.selection.state.selected.has("dir")).toBe(true);
    expect(f.selection.state.selected.has("dir/a.txt")).toBe(true);
  });

  it("Enter triggers extract-selected with the effective paths", () => {
    const f = makeKeyboard();
    f.selection.toggle("dir/a.txt");
    f.selection.state.anchorPath = "dir/a.txt";
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(f.post).toHaveBeenCalledWith(
      expect.objectContaining({ c: "extSel", paths: ["dir/a.txt"] }),
    );
  });

  it("Delete triggers delete-selected", () => {
    const f = makeKeyboard();
    f.selection.toggle("dir/a.txt");
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(f.post).toHaveBeenCalledWith({ c: "delSel", paths: ["dir/a.txt"] });
  });

  it("Escape clears selection and closes the context menu", () => {
    const f = makeKeyboard();
    f.selection.toggle("dir/a.txt");
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(f.selection.state.selected.size).toBe(0);
    expect(f.closeContextMenu).toHaveBeenCalled();
  });

  it("Ctrl+A selects every visible row", () => {
    const f = makeKeyboard();
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "a", ctrlKey: true }));
    expect(f.selection.state.selected.size).toBe(5);
  });

  it("F2 posts rename prompt for a single selection", () => {
    const f = makeKeyboard();
    f.selection.toggle("dir/a.txt");
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "F2" }));
    expect(f.post).toHaveBeenCalledWith({ c: "renamePrompt", path: "dir/a.txt" });
  });

  it("Home jumps to the first row", () => {
    const f = makeKeyboard();
    f.selection.toggle("c.txt");
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "Home" }));
    expect(f.selection.state.anchorPath).toBe("dir");
    expect(f.scrollToPath).toHaveBeenCalledWith("dir");
  });

  it("End jumps to the last row", () => {
    const f = makeKeyboard();
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "End" }));
    expect(f.selection.state.anchorPath).toBe("c.txt");
  });

  it("ignores keys typed into inputs", () => {
    const f = makeKeyboard();
    const input = document.createElement("input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(f.selection.state.anchorPath).toBeNull();
  });

  it("space toggles the anchor row", () => {
    const f = makeKeyboard();
    f.selection.toggle("dir");
    f.selection.state.anchorPath = "dir";
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: " " }));
    expect(f.selection.state.selected.has("dir")).toBe(false);
  });

  it("Ctrl+A marks a select-all in progress and selects visible rows", () => {
    const f = makeKeyboard();
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "a", ctrlKey: true }));
    expect(f.selectAllPending.value).toBe(true);
    expect(f.selection.state.selected.has("dir")).toBe(true);
    expect(f.selection.state.selected.has("c.txt")).toBe(true);
  });

  it("Escape cancels an in-flight select-all", () => {
    const f = makeKeyboard();
    f.selectAllPending.value = true;
    f.keyboard.handleKeyboard(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(f.selectAllPending.value).toBe(false);
  });
});

describe("selectAllPending + dispatcher", () => {
  it("dirChildren extends the selection for every inserted row while pending", () => {
    const f = makeFixture();
    f.selectAllPending.value = true;
    const loadExpanded = vi.fn();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: loadExpanded });
    d.handleMessage({
      c: "dirChildren",
      path: "dir/sub",
      children: [
        { name: "x.txt", path: "dir/sub/x.txt", size: 1, kind: "REGULAR_FILE" },
        { name: "y", path: "dir/sub/y", size: 0, kind: "DIRECTORY", hasMore: true, children: [] },
      ],
    });
    expect(f.selection.state.selected.has("dir/sub/x.txt")).toBe(true);
    expect(f.selection.state.selected.has("dir/sub/y")).toBe(true);
  });

  it("dirChildren does not auto-select when not pending and parent unselected", () => {
    const f = makeFixture();
    const d = createMessageDispatcher({ ...f, loadExpandedPaths: vi.fn() });
    d.handleMessage({
      c: "dirChildren",
      path: "dir/sub",
      children: [{ name: "x.txt", path: "dir/sub/x.txt", size: 1, kind: "REGULAR_FILE" }],
    });
    expect(f.selection.state.selected.has("dir/sub/x.txt")).toBe(false);
  });
});

describe("useArchiveView row interactions", () => {
  function makeView() {
    const f = makeFixture();
    const av = useArchiveView({
      post: f.post,
      onMessage: f.onMessage,
      tree: f.tree,
      treeData: f.treeData,
      selection: f.selection,
      search: {
        query: ref(""),
        isRegex: ref(false),
        regexError: ref(""),
        matchSet: ref(new Set<string>()),
        directMatchSet: ref(new Set<string>()),
        updateSearch: vi.fn(),
        isVisible: () => true,
        toggleRegex: vi.fn(),
      },
      visibleFlatNodes: f.visibleFlatNodes,
      viewState: f.viewState,
      loadingMsg: f.loadingMsg,
      archiveProps: ref(null),
      totalFiles: ref(0),
      totalDirs: ref(0),
      readOnly: ref(false),
      isSplit: ref(false),
      canSplit: ref(false),
      isEncrypted: f.isEncrypted,
      canEncrypt: ref(false),
      pwError: f.pwError,
      descCounts: ref({}),
      containerEl: f.containerEl,
      scrollToPath: f.scrollToPath,
    });
    return { ...f, av };
  }

  it("dbl-click on a file previews it", () => {
    const { av, post } = makeView();
    av.handleRowDblClick("c.txt", false);
    expect(post).toHaveBeenCalledWith({ c: "preview", path: "c.txt" });
  });

  it("dbl-click on an unloaded directory requests its children", () => {
    const { av, post } = makeView();
    av.handleRowDblClick("dir/sub", true);
    expect(post).toHaveBeenCalledWith({ c: "expandDir", path: "dir/sub" });
  });

  it("dbl-click on a loaded expanded directory collapses it", () => {
    const { av, tree, post } = makeView();
    expect(tree.expandedPaths.value.has("dir")).toBe(true);
    av.handleRowDblClick("dir", true);
    expect(tree.expandedPaths.value.has("dir")).toBe(false);
    expect(post).not.toHaveBeenCalledWith({ c: "expandDir", path: "dir" });
  });

  it("a manual row click cancels an in-flight select-all", () => {
    const { av } = makeView();
    av.selectAllPending.value = true;
    av.handleRowClick("c.txt", false, false, false);
    expect(av.selectAllPending.value).toBe(false);
  });

  it("loadExpandedPaths clears the select-all marker once nothing is pending", () => {
    const { av, tree, selection, post } = makeView();
    av.selectAllPending.value = true;
    tree.expandedPaths.value.add("dir/sub");
    // "dir/sub" hasMore + unloaded → still pending → marker survives.
    av.loadExpandedPaths();
    expect(post).toHaveBeenCalledWith({ c: "expandDir", path: "dir/sub" });
    expect(av.selectAllPending.value).toBe(true);
    // Simulate the response: children arrive → pending list empties → cleared.
    selection.state.selected.add("dir");
    av.dispatcher.handleMessage({
      c: "dirChildren",
      path: "dir/sub",
      children: [{ name: "x.txt", path: "dir/sub/x.txt", size: 1, kind: "REGULAR_FILE" }],
    });
    expect(av.selectAllPending.value).toBe(false);
  });
});
