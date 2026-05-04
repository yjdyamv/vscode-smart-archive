<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, provide, watch } from "vue";
import type { TreeNodeData, ArchiveProps } from "./types";
import { useMessage } from "./composables/useMessage";
import { useSelection } from "./composables/useSelection";
import { useSort, type SortKey } from "./composables/useSort";
import { useSearch } from "./composables/useSearch";
import { useTreeFlatten } from "./composables/useTree";
import { formatSize } from "./utils/icons";
import LoadingSpinner from "./components/LoadingSpinner.vue";
import PasswordBox from "./components/PasswordBox.vue";
import Toolbar from "./components/Toolbar.vue";
import FileTree from "./components/FileTree.vue";
import StatusBar from "./components/StatusBar.vue";
import Toast from "./components/Toast.vue";
import ContextMenu from "./components/ContextMenu.vue";

const { post, onMessage } = useMessage();
const selection = useSelection();
const search = useSearch();

const viewState = ref<"loading" | "password" | "content" | "empty">("loading");
const treeData = ref<TreeNodeData[]>([]);
const archiveProps = ref<ArchiveProps | null>(null);
const totalFiles = ref(0);
const totalDirs = ref(0);

const sort = useSort(treeData);
const tree = useTreeFlatten(treeData);

const sortedTree = computed(() => sort.sortNodes(treeData.value));

// Apply sort to treeData when sort key/direction changes
watch([sort.sortKey, sort.sortAsc], () => {
  treeData.value = sort.sortNodes([...treeData.value]);
});

const visibleFlatNodes = computed(() => {
  return tree.flatNodes.value.filter((fn) => {
    if (search.query.value.trim()) {
      return search.isVisible(fn.path);
    }
    return true;
  });
});

const toast = reactive({ show: false, msg: "", ok: true });
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const readOnly = ref(!!(window as any)._xReadOnly);

function showToast(msg: string, ok = true) {
  toast.msg = msg;
  toast.ok = ok;
  toast.show = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.show = false; }, ok ? 1800 : 4000);
}

const loadingMsg = ref("Reading archive...");

const ctxMenu = reactive({
  show: false,
  x: 0,
  y: 0,
  paths: [] as string[],
  dirPath: "",
});

function handleContextMenu(e: MouseEvent, path: string, dirPath: string) {
  // If right-clicked row is not in selection, select it alone
  if (!selection.state.selected.has(path)) {
    selection.clearAll();
    selection.toggle(path);
    selection.state.anchorPath = path;
  }
  const { paths: selectedPaths } = getEffectivePaths();
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

function ctxExtract() { extSel(); closeContextMenu(); }
function ctxDelete() { delSel(); closeContextMenu(); }
function ctxCopy() { copySel(); closeContextMenu(); }
function ctxAddHere() { post({ c: "addFiles", dir: ctxMenu.dirPath }); closeContextMenu(); }
function ctxNewFolder() { post({ c: "newFolderPrompt", dir: ctxMenu.dirPath }); closeContextMenu(); }
function ctxRename() { if (ctxMenu.paths.length === 1) renameFile(ctxMenu.paths[0]); closeContextMenu(); }

// Message handlers
function extAll() {
  post({ c: "extAll" });
  showToast("Extracting all files...", true);
}

function isAnyDirSelected(paths: string[]): boolean {
  for (const p of paths) {
    const node = findNode(treeData.value, p);
    if (node && node.kind === "DIRECTORY") return true;
  }
  return false;
}

/**
 * Returns selected paths with parent-duplication removed,
 * but ONLY if parent's ALL children are also selected.
 * If some children are deselected, the parent is broken into
 * individual selected children instead of covering them.
 */
function getEffectivePaths(): { paths: string[]; excludes: string[] } {
  const raw = [...selection.state.selected];
  const paths = new Set<string>();
  const excludes = new Set<string>();

  for (const p of raw) {
    const node = findNode(treeData.value, p);
    if (node && node.kind === "DIRECTORY" && node.children && node.children.length > 0) {
      // Directory with children: keep dir, exclude only deselected children
      paths.add(p);
      for (const child of node.children) {
        if (!selection.state.selected.has(child.path)) {
          excludes.add(child.path);
        }
      }
    } else {
      // File or empty dir: check if covered by a parent
      const parts = p.replace(/\\/g, "/").split("/");
      let covered = false;
      for (let j = parts.length - 2; j >= 0; j--) {
        const ancestor = parts.slice(0, j + 1).join("/");
        if (selection.state.selected.has(ancestor)) {
          covered = true;
          break;
        }
      }
      if (!covered) paths.add(p);
    }
  }

  return { paths: [...paths], excludes: [...excludes] };
}

function extSel() {
  const { paths, excludes } = getEffectivePaths();
  if (!paths.length) return;
  const flat = !isAnyDirSelected(paths);
  post({ c: "extSel", paths, excludes, flat });
  showToast("Extracting " + paths.length + " item(s)...", true);
}

function copySel() {
  const { paths, excludes } = getEffectivePaths();
  if (!paths.length) return;
  const flat = !isAnyDirSelected(paths);
  post({ c: "copy", paths, flat: flat });
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

function previewFile(path: string) {
  post({ c: "preview", path });
}

function renameFile(path: string) {
  post({ c: "renamePrompt", path });
}

function newFolder() {
  const dir = selection.state.lastAddDir || ctxMenu.dirPath || "";
  post({ c: "newFolderPrompt", dir });
}

function testArchive() {
  post({ c: "test" });
  showToast("Testing archive integrity...", true);
}

function submitPassword(pw: string) {
  post({ c: "pw", pw });
}

function findNode(nodes: TreeNodeData[], path: string): TreeNodeData | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

function collectDescendantPaths(node: TreeNodeData): string[] {
  const result: string[] = [];
  if (!node.children) return result;
  function walk(n: TreeNodeData) {
    if (!n.children) return;
    for (const child of n.children) {
      result.push(child.path);
      walk(child);
    }
  }
  walk(node);
  return result;
}

function toggleWithDescendants(path: string) {
  if (selection.state.selected.has(path)) {
    selection.state.selected.delete(path);
    const node = tree.findNode(treeData.value, path);
    if (node) {
      for (const childPath of collectDescendantPaths(node)) {
        selection.state.selected.delete(childPath);
      }
    }
  } else {
    selection.state.selected.add(path);
    const node = tree.findNode(treeData.value, path);
    if (node) {
      for (const childPath of collectDescendantPaths(node)) {
        selection.state.selected.add(childPath);
      }
    }
  }
}

function handleRowClick(path: string, isDir: boolean, shift: boolean, ctrl: boolean) {
  if (shift && selection.state.anchorPath) {
    const flatList = visibleFlatNodes.value;
    const anchorIdx = flatList.findIndex((f) => f.path === selection.state.anchorPath);
    const targetIdx = flatList.findIndex((f) => f.path === path);
    if (anchorIdx >= 0 && targetIdx >= 0) {
      const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      for (let i = from; i <= to; i++) {
        toggleWithDescendants(flatList[i].path);
      }
    }
  } else if (ctrl) {
    selection.toggle(path);
  } else {
    selection.clearAll();
    selection.toggle(path);
  }
  selection.state.anchorPath = path;
}

function handleRowDblClick(path: string, isDir: boolean) {
  if (isDir) {
    expandOrLoad(path);
  } else {
    previewFile(path);
  }
}

function handleExpandClick(path: string) {
  expandOrLoad(path);
}

function handleCheckClick(path: string) {
  toggleWithDescendants(path);
  selection.state.anchorPath = path;
}

function loadExpandedPaths() {
  const needsLoad = tree.getPathsNeedingLoad();
  for (const path of needsLoad) {
    tree.setLoading(path);
    post({ c: "expandDir", path });
  }
}

function expandOrLoad(path: string) {
  const node = tree.findNode(treeData.value, path);
  if (!node || node.kind !== "DIRECTORY") return;

  // If already expanded, just toggle
  if (tree.expandedPaths.value.has(path)) {
    tree.toggleExpand(path);
    return;
  }

  // If directory has children already loaded, expand normally
  if (node.children && node.children.length > 0) {
    tree.toggleExpand(path);
    return;
  }

  // If directory has more children but not loaded, request them
  if (node.hasMore && (!node.children || node.children.length === 0)) {
    tree.toggleExpand(path); // expand to show loading state
    tree.setLoading(path);
    post({ c: "expandDir", path });
    return;
  }

  // Empty directory - just toggle
  tree.toggleExpand(path);
}

// Selection counts for toolbar
const selectionBreakdown = computed(() => {
  let dirs = 0;
  let files = 0;
  for (const p of selection.state.selected) {
    const node = findNode(treeData.value, p);
    if (!node) continue;
    if (node.kind === "DIRECTORY") dirs++;
    else files++;
  }
  return { dirs, files };
});

onMounted(() => {
  const rawTree = window._xTree ?? [];
  const props = window._xProps;
  const files = window._xFiles ?? 0;
  const dirs = window._xDirs ?? 0;
  const initView = window._xViewState;

  if (initView === "password") {
    if (props) archiveProps.value = props;
    viewState.value = "password";
    return;
  }

  if (props) {
    archiveProps.value = props;
    totalFiles.value = files;
    totalDirs.value = dirs;
  }

  if (rawTree.length > 0) {
    treeData.value = rawTree;
    viewState.value = "content";
    tree.initExpandedFromTree();
    // Show toast from page reload (after delete/rename/add/folder operations)
    const toastMsg = window._xToast;
    if (toastMsg) showToast(toastMsg, true);
    // Trigger lazy loading for auto-expanded (non-noisy) directories
    loadExpandedPaths();
  } else {
    viewState.value = "empty";
  }

  onMessage((msg) => {
    switch (msg.c) {
      case "ok":
        showToast(msg.t as string, true);
        break;
      case "err":
        showToast(msg.t as string, false);
        break;
      case "loading":
        if (typeof msg.t === "string") {
          loadingMsg.value = msg.t;
          viewState.value = "loading";
        } else {
          viewState.value = msg.t ? "loading" : "content";
        }
        break;
      case "pwerr":
        showToast(msg.t as string || "Wrong password", false);
        break;
      case "dirChildren": {
        const parentPath = msg.path as string;
        const children = msg.children as TreeNodeData[];
        if (parentPath && Array.isArray(children)) {
          const result = tree.insertChildren(parentPath, children);
          // If parent is selected, auto-select loaded children
          if (selection.state.selected.has(parentPath)) {
            for (const childPath of result.childPaths) {
              selection.state.selected.add(childPath);
            }
          }
          // Chain-load descendants that are in expanded set
          for (const childPath of result.needsLoad) {
            tree.setLoading(childPath);
            post({ c: "expandDir", path: childPath });
          }
        }
        break;
      }
    }
  });

  document.addEventListener("keydown", handleKeyboard);

  onUnmounted(() => {
    document.removeEventListener("keydown", handleKeyboard);
  });
});

function handleKeyboard(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    for (const fn of visibleFlatNodes.value) {
      selection.state.selected.add(fn.path);
    }
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
    if (paths.length === 1) {
      post({ c: "renamePrompt", path: paths[0] });
    }
  }
  if (e.key === "Enter" && selection.hasSelected()) {
    e.preventDefault();
    extSel();
  }
  if (e.key === "Escape") {
    selection.clearAll();
    ctxMenu.show = false;
  }
  if (e.key === " " && selection.state.anchorPath) {
    e.preventDefault();
    selection.toggle(selection.state.anchorPath);
  }
  if (e.key === "Delete" && selection.hasSelected()) {
    e.preventDefault();
    delSel();
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    navigateRows(1, e.shiftKey);
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    navigateRows(-1, e.shiftKey);
  }
}

function navigateRows(delta: number, shift: boolean) {
  const flatList = visibleFlatNodes.value;
  if (!flatList.length) return;
  let idx = selection.state.anchorPath
    ? flatList.findIndex((f) => f.path === selection.state.anchorPath)
    : -1;
  if (idx < 0) idx = delta > 0 ? -1 : flatList.length;
  idx = Math.max(0, Math.min(idx + delta, flatList.length - 1));
  const targetPath = flatList[idx].path;
  if (!shift) {
    selection.clearAll();
  }
  selection.toggle(targetPath);
  selection.state.anchorPath = targetPath;
}

provide("selection", selection);
provide("tree", tree);
provide("search", search);
provide("sort", sort);
provide("postMessage", post);
provide("showToast", showToast);
</script>

<template>
  <div class="flex flex-col h-screen text-[var(--vscode-foreground)] bg-[var(--vscode-sideBar-background)] font-[var(--vscode-font-family)]" style="font-size:var(--vscode-font-size)">
    <LoadingSpinner v-if="viewState === 'loading'" :msg="loadingMsg" />
    <PasswordBox
      v-else-if="viewState === 'password'"
      :archive-name="archiveProps?.name ?? ''"
      @submit="submitPassword"
    />
    <template v-else-if="viewState === 'content'">
      <Toolbar
        :read-only="readOnly"
        :selected-count="selection.state.selected.size"
        :selected-files="selectionBreakdown.files"
        :selected-dirs="selectionBreakdown.dirs"
        :total-files="totalFiles"
        :total-dirs="totalDirs"
        :sort-key="sort.sortKey.value"
        :sort-asc="sort.sortAsc.value"
        :search-query="search.query.value"
        :last-add-dir="selection.state.lastAddDir"
        @extract-all="extAll"
        @extract-selected="extSel"
        @delete-selected="delSel"
        @add-files="addFiles"
        @copy="copySel"
        @expand-all="tree.expandAll"
        @collapse-all="tree.collapseAll"
        @sort="(k: SortKey) => sort.setSort(k)"
        @search="(q: string) => search.updateSearch(q, sortedTree)"
      />
      <FileTree
        :flat-nodes="visibleFlatNodes"
        :tree-data="treeData"
        :selected="selection.state.selected"
        :expanded="tree.expandedPaths.value"
        :search-query="search.query.value"
        :match-set="search.matchSet.value"
        :loading-paths="tree.loadingPaths.value"
        @row-click="handleRowClick"
        @row-dblclick="handleRowDblClick"
        @check-click="handleCheckClick"
        @expand-click="handleExpandClick"
        @context-menu="handleContextMenu"
      />
      <StatusBar
        v-if="archiveProps"
        :name="archiveProps.name"
        :format="archiveProps.format"
        :count="archiveProps.count"
        :files="totalFiles"
        :dirs="totalDirs"
        :size="archiveProps.size"
        @test="testArchive"
      />
    </template>
    <div v-else class="flex flex-col items-center justify-center h-full gap-3 text-[var(--vscode-descriptionForeground)]">
      <div class="text-4xl opacity-40">📭</div>
      <div class="text-sm">{{ archiveProps?.name ?? "Archive" }}</div>
      <div class="text-xs opacity-60">No files to display</div>
    </div>

    <Toast :msg="toast.msg" :ok="toast.ok" :visible="toast.show" />
    <ContextMenu
      v-if="ctxMenu.show"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :paths="ctxMenu.paths"
      :dir-path="ctxMenu.dirPath"
      :read-only="readOnly"
      @close="closeContextMenu"
      @extract="ctxExtract"
      @delete="ctxDelete"
      @copy="ctxCopy"
      @add-here="ctxAddHere"
      @new-folder="ctxNewFolder"
      @rename="ctxRename"
    />
  </div>
</template>
