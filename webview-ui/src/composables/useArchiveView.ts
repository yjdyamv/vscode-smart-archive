import { reactive, ref, computed, type Ref, type ComputedRef } from "vue";
import type { TreeNodeData, FlatNode, ArchiveProps } from "../types";
import type { WebviewToHost, HostToWebview } from "../protocol";
import type { DescCount } from "../bootstrap";
import { isCoveredByAncestor } from "./useSelection";
import type { SelectionController } from "./useSelection";
import type { SearchController } from "./useSearch";
import type { TreeController } from "./useTree";
import { createHostOps } from "./archiveOps";
import { createMessageDispatcher } from "./messageDispatcher";
import { createKeyboardNav } from "./keyboardNav";
import { TOAST_SUCCESS_MS, TOAST_ERROR_MS, SEARCH_DEBOUNCE_MS } from "../constants";

export interface ArchiveViewContext {
  post: (msg: WebviewToHost) => void;
  onMessage: (handler: (msg: HostToWebview) => void) => () => void;
  tree: TreeController;
  treeData: Ref<TreeNodeData[]>;
  selection: SelectionController;
  search: SearchController;
  visibleFlatNodes: ComputedRef<FlatNode[]>;
  viewState: Ref<string>;
  loadingMsg: Ref<string>;
  archiveProps: Ref<ArchiveProps | null>;
  totalFiles: Ref<number>;
  totalDirs: Ref<number>;
  readOnly: Ref<boolean>;
  isSplit: Ref<boolean>;
  canSplit: Ref<boolean>;
  isEncrypted: Ref<boolean>;
  canEncrypt: Ref<boolean>;
  pwError: Ref<boolean>;
  descCounts: Ref<Record<string, DescCount>>;
  containerEl: Ref<HTMLElement | null>;
  scrollToPath: (path: string) => void;
}

/**
 * Archive view composition root: wires the internal seams (host ops, message
 * dispatch, keyboard navigation) to the shared controllers and exposes the
 * single interface App.vue binds to.
 */
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
    toastTimer = setTimeout(
      () => {
        toast.show = false;
      },
      ok ? TOAST_SUCCESS_MS : TOAST_ERROR_MS,
    );
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
    searchDebounce = setTimeout(() => search.updateSearch(q, treeData.value), SEARCH_DEBOUNCE_MS);
  }

  // ── Tree helpers ───────────────────────────────────────────────────

  function getVisibleDescendants(node: TreeNodeData): string[] {
    const prefix = node.path + "/";
    return tree.flatNodes.value.filter((fn) => fn.path.startsWith(prefix)).map((fn) => fn.path);
  }

  function expandOrLoad(path: string) {
    const node = tree.findNode(path);
    if (!node || node.kind !== "DIRECTORY") return;
    if (tree.expandedPaths.value.has(path)) {
      tree.toggleExpand(path);
      return;
    }
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
    const pending = tree.getPathsNeedingLoad();
    for (const path of pending) {
      tree.setLoading(path);
      post({ c: "expandDir", path });
    }
    // Ctrl+A select-all drain finished: every lazy subtree has now been
    // requested, so stop auto-extending the selection on insertions.
    if (selectAllPending.value && pending.length === 0) selectAllPending.value = false;
  }

  function handleRowDblClick(path: string, isDir: boolean) {
    if (isDir) expandOrLoad(path);
    else ops.previewFile(path);
  }

  function handleExpandClick(path: string) {
    expandOrLoad(path);
  }

  function handleCheckClick(path: string) {
    toggleWithDescendants(path);
    selection.state.anchorPath = path;
  }

  // ── Context menu state (ops.newFolder reads the target dir) ────────

  const ctxMenu = reactive({ show: false, x: 0, y: 0, paths: [] as string[], dirPath: "" });

  // Ctrl+A select-all marker: active while lazy loads from expand-all are
  // draining; the dispatcher auto-selects inserted subtrees while set.
  const selectAllPending = ref(false);

  // ── Internal seams ─────────────────────────────────────────────────

  const ops = createHostOps({
    post,
    tree,
    selection,
    showToast,
    viewState,
    loadingMsg,
    pwError: ctx.pwError,
    getCtxDir: () => ctxMenu.dirPath,
  });

  const dispatcher = createMessageDispatcher({
    onMessage: ctx.onMessage,
    tree,
    selection,
    showToast,
    viewState,
    loadingMsg,
    pwError: ctx.pwError,
    isEncrypted: ctx.isEncrypted,
    loadExpandedPaths,
    selectAllPending,
  });

  const keyboard = createKeyboardNav({
    visibleFlatNodes,
    selection,
    tree,
    post,
    scrollToPath: ctx.scrollToPath,
    containerEl: ctx.containerEl,
    closeContextMenu,
    expandAllAndLoad: () => {
      tree.expandAll();
      loadExpandedPaths();
    },
    selectAllPending,
    ops,
  });

  // ── Selection counts ───────────────────────────────────────────────

  const descCounts = ctx.descCounts;

  const selectionBreakdown = computed(() => {
    let dirs = 0;
    let files = 0;
    for (const p of selection.state.selected) {
      if (isCoveredByAncestor(p, selection.state.selected)) continue;
      const node = tree.nodeMap.value.get(p);
      if (!node) continue;
      if (node.kind === "DIRECTORY") {
        dirs += 1;
        const dc = descCounts.value[p];
        if (dc) {
          files += dc.files;
          dirs += dc.dirs;
        }
      } else {
        files += 1;
      }
    }
    return { dirs, files };
  });

  const selectedCount = computed(
    () => selectionBreakdown.value.dirs + selectionBreakdown.value.files,
  );

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
    // Any manual row interaction cancels an in-flight Ctrl+A select-all so
    // later lazy loads stop auto-extending the selection.
    selectAllPending.value = false;
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

  // ── Context menu handlers ──────────────────────────────────────────

  function handleContextMenu(e: MouseEvent, path: string, dirPath: string) {
    if (!selection.state.selected.has(path)) {
      selection.clearAll();
      selection.toggle(path);
      selection.state.anchorPath = path;
    }
    selection.state.lastAddDir = dirPath;
    const { paths: selectedPaths } = ops.getEffectivePaths();
    if (!selectedPaths.length) return;
    ctxMenu.show = true;
    ctxMenu.x = e.clientX;
    ctxMenu.y = e.clientY;
    ctxMenu.paths = selectedPaths;
    ctxMenu.dirPath = dirPath;
    e.preventDefault();
  }

  function closeContextMenu() {
    ctxMenu.show = false;
  }
  function ctxExtract() {
    ops.extSel();
    closeContextMenu();
  }
  function ctxDelete() {
    ops.delSel();
    closeContextMenu();
  }
  function ctxCopy() {
    ops.copySel();
    closeContextMenu();
  }
  function ctxAddHere() {
    post({ c: "addFiles", dir: ctxMenu.dirPath });
    closeContextMenu();
  }
  function ctxNewFolder() {
    post({ c: "newFolderPrompt", dir: ctxMenu.dirPath });
    closeContextMenu();
  }
  function ctxRename() {
    if (ctxMenu.paths.length === 1) ops.renameFile(ctxMenu.paths[0]);
    closeContextMenu();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

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
    getEffectivePaths: ops.getEffectivePaths,
    // Select-all marker (exposed for tests)
    selectAllPending,
    dispatcher,
    // Row handlers
    handleRowClick,
    handleRowDblClick,
    handleExpandClick,
    handleCheckClick,
    // Operations
    extAll: ops.extAll,
    extSel: ops.extSel,
    copySel: ops.copySel,
    delSel: ops.delSel,
    addFiles: ops.addFiles,
    previewFile: ops.previewFile,
    renameFile: ops.renameFile,
    newFolder: ops.newFolder,
    testArchive: ops.testArchive,
    convertFormat: ops.convertFormat,
    mergeVolumes: ops.mergeVolumes,
    splitVolumes: ops.splitVolumes,
    encryptArchive: ops.encryptArchive,
    decryptArchive: ops.decryptArchive,
    submitPassword: ops.submitPassword,
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
    handleKeyboard: keyboard.handleKeyboard,
    // Lifecycle
    setupMessageHandler: dispatcher.setup,
    cleanup,
    loadExpandedPaths,
    expandOrLoad,
  };
}
