import { ref, reactive, computed, type Ref, type ComputedRef } from "vue";
import type { TreeNodeData } from "../types";
import type { ExtensionMessage } from "../types";
import { isCoveredByAncestor } from "./useSelection";

export interface ArchiveViewContext {
  post: (msg: Record<string, unknown>) => void;
  onMessage: (handler: (msg: ExtensionMessage) => void) => () => void;
  tree: ReturnType<typeof import("./useTree").useTreeFlatten>;
  treeData: Ref<TreeNodeData[]>;
  selection: ReturnType<typeof import("./useSelection").useSelection>;
  search: ReturnType<typeof import("./useSearch").useSearch>;
  visibleFlatNodes: ComputedRef<
    ReturnType<typeof import("./useTree").useTreeFlatten>["flatNodes"]["value"]
  >;
  viewState: Ref<string>;
  loadingMsg: Ref<string>;
  archiveProps: Ref<{ name: string; format: string; count: number; size: string } | null>;
  totalFiles: Ref<number>;
  totalDirs: Ref<number>;
  readOnly: Ref<boolean>;
  isSplit: Ref<boolean>;
  canSplit: Ref<boolean>;
  isEncrypted: Ref<boolean>;
  canEncrypt: Ref<boolean>;
  containerEl: Ref<HTMLElement | null>;
  scrollToPath: (path: string) => void;
}

export function useArchiveView(ctx: ArchiveViewContext) {
  const { post, tree, treeData, selection, search, visibleFlatNodes, viewState, loadingMsg } = ctx;

  // ── Toast ──────────────────────────────────────────────────────────

  const toast = reactive({ show: false, msg: "", ok: true });
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showToast(msg: string, ok = true) {
    toast.msg = msg;
    toast.ok = ok;
    toast.show = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.show = false; }, ok ? 1800 : 4000);
  }

  // ── Search debounce ────────────────────────────────────────────────

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  const searchMatchCount = computed(() => {
    if (!search.query.value.trim()) return 0;
    return search.directMatchSet.value.size;
  });

  function onToggleRegex() {
    search.toggleRegex(treeData.value);
  }

  function onSearch(q: string) {
    search.query.value = q;
    if (!q.trim()) search.matchSet.value = new Set();
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => search.updateSearch(q, treeData.value), 150);
  }

  // ── Tree helpers ───────────────────────────────────────────────────

  function getVisibleDescendants(node: TreeNodeData): string[] {
    const prefix = node.path + "/";
    return tree.flatNodes.value
      .filter((fn) => fn.path.startsWith(prefix))
      .map((fn) => fn.path);
  }

  function expandOrLoad(path: string) {
    const node = tree.findNode(path);
    if (!node || node.kind !== "DIRECTORY") return;
    if (tree.expandedPaths.value.has(path)) { tree.toggleExpand(path); return; }
    if (node.children && node.children.length > 0) { tree.toggleExpand(path); return; }
    if (node.hasMore && (!node.children || node.children.length === 0)) {
      if (tree.loadingPaths.value.has(path)) return;
      tree.toggleExpand(path);
      tree.setLoading(path);
      post({ c: "expandDir", path });
      return;
    }
    tree.toggleExpand(path);
  }

  function loadExpandedPaths() {
    for (const path of tree.getPathsNeedingLoad()) {
      tree.setLoading(path);
      post({ c: "expandDir", path });
    }
  }

  function handleRowDblClick(path: string, isDir: boolean) {
    if (isDir) expandOrLoad(path);
    else previewFile(path);
  }

  function handleExpandClick(path: string) {
    expandOrLoad(path);
  }

  function handleCheckClick(path: string) {
    toggleWithDescendants(path);
    selection.state.anchorPath = path;
  }

  // ── Selection helpers ──────────────────────────────────────────────

  function isAnyDirSelected(paths: string[]): boolean {
    for (const p of paths) {
      const node = tree.findNode(p);
      if (node && node.kind === "DIRECTORY") return true;
    }
    return false;
  }

  function getEffectivePaths(): { paths: string[]; excludes: string[] } {
    const raw = [...selection.state.selected];
    const paths = new Set<string>();
    const excludes = new Set<string>();
    for (const p of raw) {
      const node = tree.findNode(p);
      if (node && node.kind === "DIRECTORY" && node.children && node.children.length > 0) {
        const hasAnyChildSelected = node.children.some((c) => selection.state.selected.has(c.path));
        if (hasAnyChildSelected) {
          paths.add(p);
          for (const child of node.children) {
            if (!selection.state.selected.has(child.path)) excludes.add(child.path);
          }
        } else {
          paths.add(p);
        }
      } else {
        if (!isCoveredByAncestor(p, selection.state.selected)) paths.add(p);
      }
    }
    return { paths: [...paths], excludes: [...excludes] };
  }

  // ── Selection counts ───────────────────────────────────────────────

  const descCounts = window._xDescCounts ?? {};

  const selectionBreakdown = computed(() => {
    let dirs = 0;
    let files = 0;
    for (const p of selection.state.selected) {
      if (isCoveredByAncestor(p, selection.state.selected)) continue;
      const node = tree.nodeMap.value.get(p);
      if (!node) continue;
      if (node.kind === "DIRECTORY") {
        dirs += 1;
        const dc = descCounts[p];
        if (dc) { files += dc.files; dirs += dc.dirs; }
      } else {
        files += 1;
      }
    }
    return { dirs, files };
  });

  const selectedCount = computed(() => selectionBreakdown.value.dirs + selectionBreakdown.value.files);

  // ── Row click / toggle ─────────────────────────────────────────────

  function toggleWithDescendants(path: string) {
    const wasSelected = selection.state.selected.has(path);
    if (wasSelected) {
      selection.state.selected.delete(path);
      const node = tree.findNode(path);
      if (node) {
        for (const childPath of getVisibleDescendants(node)) {
          selection.state.selected.delete(childPath);
        }
      }
    } else {
      selection.state.selected.add(path);
      const node = tree.findNode(path);
      if (node) {
        for (const childPath of getVisibleDescendants(node)) {
          selection.state.selected.add(childPath);
        }
        if (node.hasMore && (!node.children || node.children.length === 0)) {
          tree.toggleExpand(path);
          tree.setLoading(path);
          post({ c: "expandDir", path });
        }
      }
    }
  }

  function handleRowClick(path: string, _isDir: boolean, shift: boolean, ctrl: boolean) {
    if (shift && selection.state.anchorPath) {
      const flatList = visibleFlatNodes.value;
      const anchorIdx = flatList.findIndex((f) => f.path === selection.state.anchorPath);
      const targetIdx = flatList.findIndex((f) => f.path === path);
      if (anchorIdx >= 0 && targetIdx >= 0) {
        const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
        for (let i = from; i <= to; i++) {
          const nodePath = flatList[i].path;
          if (!selection.state.selected.has(nodePath)) {
            selection.state.selected.add(nodePath);
            const node = tree.findNode(nodePath);
            if (node && node.kind === "DIRECTORY") {
              for (const childPath of getVisibleDescendants(node)) {
                selection.state.selected.add(childPath);
              }
            }
          }
        }
      }
    } else if (ctrl) {
      selection.toggle(path, _isDir);
    } else {
      selection.clearAll();
      selection.toggle(path, _isDir);
    }
    selection.state.anchorPath = path;
  }

  // ── Operations ─────────────────────────────────────────────────────

  function extAll() { post({ c: "extAll" }); showToast("Extracting all files...", true); }

  function extSel() {
    const { paths, excludes } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "extSel", paths, excludes, flat: !isAnyDirSelected(paths) });
    showToast("Extracting " + paths.length + " item(s)...", true);
  }

  function copySel() {
    const { paths, excludes } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "copy", paths, flat: !isAnyDirSelected(paths) });
    showToast("Copied " + paths.length + " item(s)", true);
  }

  function delSel() {
    const { paths } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "delSel", paths });
    loadingMsg.value = "Deleting " + paths.length + " item(s)...";
    viewState.value = "loading";
  }

  function addFiles() {
    const dir = selection.state.lastAddDir;
    post({ c: "addFiles", dir });
    showToast("Adding to " + (dir || "archive root"), true);
  }

  function previewFile(path: string) { post({ c: "preview", path }); }
  function renameFile(path: string) { post({ c: "renamePrompt", path }); }

  function newFolder() {
    const dir = selection.state.lastAddDir || ctxMenu.dirPath || "";
    post({ c: "newFolderPrompt", dir });
  }

  function testArchive() { post({ c: "test" }); showToast("Testing archive integrity...", true); }
  function convertFormat() { post({ c: "convert" }); }
  function mergeVolumes() { post({ c: "merge" }); showToast("Merging split volumes...", true); }
  function splitVolumes() { post({ c: "split" }); }
  function encryptArchive() { post({ c: "encrypt" }); showToast("Adding encryption...", true); }
  function decryptArchive() { post({ c: "decrypt" }); showToast("Removing encryption...", true); }
  function submitPassword(pw: string) { post({ c: "pw", pw }); }

  // ── Context menu ───────────────────────────────────────────────────

  const ctxMenu = reactive({ show: false, x: 0, y: 0, paths: [] as string[], dirPath: "" });

  function handleContextMenu(e: MouseEvent, path: string, dirPath: string) {
    if (!selection.state.selected.has(path)) {
      selection.clearAll();
      selection.toggle(path);
      selection.state.anchorPath = path;
    }
    selection.state.lastAddDir = dirPath;
    const { paths: selectedPaths } = getEffectivePaths();
    if (!selectedPaths.length) return;
    ctxMenu.show = true;
    ctxMenu.x = e.clientX;
    ctxMenu.y = e.clientY;
    ctxMenu.paths = selectedPaths;
    ctxMenu.dirPath = dirPath;
    e.preventDefault();
  }

  function closeContextMenu() { ctxMenu.show = false; }
  function ctxExtract() { extSel(); closeContextMenu(); }
  function ctxDelete() { delSel(); closeContextMenu(); }
  function ctxCopy() { copySel(); closeContextMenu(); }
  function ctxAddHere() { post({ c: "addFiles", dir: ctxMenu.dirPath }); closeContextMenu(); }
  function ctxNewFolder() { post({ c: "newFolderPrompt", dir: ctxMenu.dirPath }); closeContextMenu(); }
  function ctxRename() { if (ctxMenu.paths.length === 1) renameFile(ctxMenu.paths[0]); closeContextMenu(); }

  // ── Keyboard ───────────────────────────────────────────────────────

  function navigateRows(delta: number, shift: boolean) {
    const flatList = visibleFlatNodes.value;
    if (!flatList.length) return;
    let idx = selection.state.anchorPath ? flatList.findIndex((f) => f.path === selection.state.anchorPath) : -1;
    if (idx < 0) idx = delta > 0 ? -1 : flatList.length;
    idx = Math.max(0, Math.min(idx + delta, flatList.length - 1));
    const targetPath = flatList[idx].path;
    const targetIsDir = flatList[idx].node.kind === "DIRECTORY";
    if (!shift) selection.clearAll();
    selection.toggle(targetPath, targetIsDir);
    selection.state.anchorPath = targetPath;
    ctx.scrollToPath(targetPath);
  }

  function getPageSize(): number {
    const el = ctx.containerEl.value;
    if (!el) return 15;
    const fontSize =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--vscode-font-size")) ||
      parseFloat(getComputedStyle(document.documentElement).fontSize) ||
      14;
    return Math.max(1, Math.floor(el.clientHeight / (fontSize * 1.85)));
  }

  function handleKeyboard(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      tree.expandAll();
      loadExpandedPaths();
      for (const fn of visibleFlatNodes.value) selection.state.selected.add(fn.path);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && selection.hasSelected()) {
      const ts = window.getSelection();
      if (ts && ts.toString().length > 0) return;
      e.preventDefault();
      copySel();
    }
    if (e.key === "F2" && selection.state.selected.size === 1) {
      e.preventDefault();
      const paths = selection.getSelectedPaths();
      if (paths.length === 1) post({ c: "renamePrompt", path: paths[0] });
    }
    if (e.key === "Enter" && selection.hasSelected()) { e.preventDefault(); extSel(); }
    if (e.key === "Escape") { selection.clearAll(); ctxMenu.show = false; }
    if (e.key === " " && selection.state.anchorPath) { e.preventDefault(); selection.toggle(selection.state.anchorPath); }
    if (e.key === "Delete" && selection.hasSelected()) { e.preventDefault(); delSel(); }
    if (e.key === "ArrowDown") { e.preventDefault(); navigateRows(1, e.shiftKey); }
    if (e.key === "ArrowUp") { e.preventDefault(); navigateRows(-1, e.shiftKey); }
    if (e.key === "PageDown") {
      e.preventDefault();
      const page = getPageSize();
      ctx.containerEl.value?.scrollBy({ top: ctx.containerEl.value.clientHeight, behavior: "auto" });
      navigateRows(page, e.shiftKey);
    }
    if (e.key === "PageUp") {
      e.preventDefault();
      const page = getPageSize();
      ctx.containerEl.value?.scrollBy({ top: -ctx.containerEl.value.clientHeight, behavior: "auto" });
      navigateRows(-page, e.shiftKey);
    }
    if (e.key === "Home") {
      e.preventDefault();
      const flatList = visibleFlatNodes.value;
      if (!flatList.length) return;
      if (!e.shiftKey) selection.clearAll();
      selection.toggle(flatList[0].path, flatList[0].node.kind === "DIRECTORY");
      selection.state.anchorPath = flatList[0].path;
      ctx.scrollToPath(flatList[0].path);
    }
    if (e.key === "End") {
      e.preventDefault();
      const flatList = visibleFlatNodes.value;
      if (!flatList.length) return;
      const last = flatList[flatList.length - 1];
      if (!e.shiftKey) selection.clearAll();
      selection.toggle(last.path, last.node.kind === "DIRECTORY");
      selection.state.anchorPath = last.path;
      ctx.scrollToPath(last.path);
    }
  }

  // ── Message handler ────────────────────────────────────────────────

  function setupMessageHandler() {
    return ctx.onMessage((msg: ExtensionMessage) => {
      switch (msg.c) {
        case "ok":
          showToast(msg.t, true);
          viewState.value = "content";
          break;
        case "err":
          showToast(msg.t, false);
          viewState.value = "content";
          break;
        case "loading":
          if (typeof msg.t === "string") { loadingMsg.value = msg.t; viewState.value = "loading"; }
          else { viewState.value = msg.t ? "loading" : "content"; }
          break;
        case "pwerr":
          showToast(msg.t || "Wrong password", false);
          break;
        case "encState":
          ctx.isEncrypted.value = !!msg.v;
          break;
        case "dirChildren": {
          const parentPath = msg.path;
          const children = msg.children;
          if (parentPath && Array.isArray(children)) {
            const childPaths = tree.insertChildren(parentPath, children);
            for (const c of children) {
              if (c.kind === "DIRECTORY" && (c.hasMore || (c.children?.length ?? 0) > 0)) {
                if (!c.collapsed && tree.shouldAutoExpandChild(c.path)) {
                  tree.expandedPaths.value.add(c.path);
                }
              }
            }
            if (selection.state.selected.has(parentPath)) {
              for (const childPath of childPaths) selection.state.selected.add(childPath);
            }
            loadExpandedPaths();
          }
          break;
        }
      }
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  function cleanup() {
    if (toastTimer) clearTimeout(toastTimer);
    if (searchDebounce) clearTimeout(searchDebounce);
    ctx.selection.flushSave();
  }

  return {
    // Toast
    toast,
    showToast,
    // Search
    searchMatchCount,
    onToggleRegex,
    onSearch,
    // Selection
    selectionBreakdown,
    selectedCount,
    getEffectivePaths,
    // Row handlers
    handleRowClick,
    handleRowDblClick,
    handleExpandClick,
    handleCheckClick,
    // Operations
    extAll,
    extSel,
    copySel,
    delSel,
    addFiles,
    previewFile,
    renameFile,
    newFolder,
    testArchive,
    convertFormat,
    mergeVolumes,
    splitVolumes,
    encryptArchive,
    decryptArchive,
    submitPassword,
    // Context menu
    ctxMenu,
    handleContextMenu,
    closeContextMenu,
    ctxExtract,
    ctxDelete,
    ctxCopy,
    ctxAddHere,
    ctxNewFolder,
    ctxRename,
    // Keyboard
    handleKeyboard,
    // Lifecycle
    setupMessageHandler,
    cleanup,
    loadExpandedPaths,
    expandOrLoad,
  };
}
