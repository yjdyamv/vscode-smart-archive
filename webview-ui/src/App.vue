<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, provide } from "vue";
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

function showToast(msg: string, ok = true) {
  toast.msg = msg;
  toast.ok = ok;
  toast.show = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.show = false; }, 1800);
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
  const selectedPaths = getEffectivePaths();
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
function getEffectivePaths(): string[] {
  const raw = [...selection.state.selected];
  const result = new Set<string>();
  const parentsToRemove = new Set<string>();

  for (const p of raw) {
    // If this path is a directory with children
    const node = findNode(treeData.value, p);
    if (node && node.kind === "DIRECTORY" && node.children && node.children.length > 0) {
      const childSelected = node.children.filter((c) => selection.state.selected.has(c.path));
      const allSelected = childSelected.length === node.children.length;
      const someSelected = childSelected.length > 0;
      if (allSelected) {
        // All children selected → keep parent, skip children
        result.add(p);
      } else if (someSelected) {
        // Partial selection → exclude parent, keep selected children
        parentsToRemove.add(p);
        for (const c of childSelected) result.add(c.path);
      } else {
        // No children selected → keep parent
        result.add(p);
      }
    } else {
      // File or empty dir: check if covered by a fully-selected parent
      const parts = p.replace(/\\/g, "/").split("/");
      let covered = false;
      for (let j = parts.length - 2; j >= 0; j--) {
        const ancestor = parts.slice(0, j + 1).join("/");
        if (selection.state.selected.has(ancestor)) {
          const ancNode = findNode(treeData.value, ancestor);
          if (ancNode && ancNode.children && ancNode.children.length > 0) {
            const allSelected = ancNode.children.every((c) =>
              selection.state.selected.has(c.path),
            );
            if (allSelected) {
              covered = true;
              result.add(ancestor); // parent covers it
            }
          }
          break;
        }
      }
      if (!covered) result.add(p);
    }
  }

  // Remove parents that were broken into children
  for (const p of parentsToRemove) result.delete(p);

  return [...result];
}

function extSel() {
  const paths = getEffectivePaths();
  if (!paths.length) return;
  const flat = !isAnyDirSelected(paths);
  post({ c: "extSel", paths, flat });
  showToast("Extracting " + paths.length + " item(s)...", true);
}

function delSel() {
  const paths = getEffectivePaths();
  if (!paths.length) return;
  post({ c: "delSel", paths });
  loadingMsg.value = "Deleting " + paths.length + " item(s)...";
  viewState.value = "loading";
}

function copySel() {
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

function skipPassword() {
  post({ c: "skipPw" });
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
  const selected = getEffectivePaths();
  let dirs = 0;
  let files = 0;
  for (const p of selected) {
    const node = findNode(treeData.value, p);
    if (!node) continue;
    if (node.kind === "DIRECTORY") {
      dirs++;
      const childStats = countChildren(node.children);
      dirs += childStats.dirs;
      files += childStats.files;
    } else {
      files++;
    }
  }
  return { dirs, files };
});

function countChildren(nodes: TreeNodeData[] | undefined): { dirs: number; files: number } {
  let d = 0;
  let f = 0;
  if (!nodes) return { dirs: d, files: f };
  for (const n of nodes) {
    if (n.kind === "DIRECTORY") {
      d++;
      const child = countChildren(n.children);
      d += child.dirs;
      f += child.files;
    } else {
      f++;
    }
  }
  return { dirs: d, files: f };
}

onMounted(() => {
  const rawTree = window._xTree ?? [];
  const props = window._xProps;
  const files = window._xFiles ?? 0;
  const dirs = window._xDirs ?? 0;

  if (props) {
    archiveProps.value = props;
    totalFiles.value = files;
    totalDirs.value = dirs;
  }

  if (rawTree.length > 0) {
    treeData.value = rawTree;
    viewState.value = "content";
    tree.initExpandedFromTree();
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
      case "del-ok":
        showToast(msg.t as string, true);
        break;
      case "loading":
        loadingMsg.value = (msg.t as string) || "Working...";
        viewState.value = (msg.t === true) ? "loading" : "content";
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
  <div class="app">
    <LoadingSpinner v-if="viewState === 'loading'" :msg="loadingMsg" />
    <PasswordBox
      v-else-if="viewState === 'password'"
      :archive-name="archiveProps?.name ?? ''"
      @submit="submitPassword"
      @skip="skipPassword"
    />
    <template v-else-if="viewState === 'content'">
      <Toolbar
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
    <div v-else class="empty-state">
      {{ archiveProps?.name ?? "Archive" }} (empty)
    </div>

    <Toast :msg="toast.msg" :ok="toast.ok" :visible="toast.show" />
    <ContextMenu
      v-if="ctxMenu.show"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :paths="ctxMenu.paths"
      :dir-path="ctxMenu.dirPath"
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

<style>
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  overflow: hidden;
}
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.empty-state {
  text-align: center;
  color: var(--vscode-descriptionForeground);
  padding: 4em 1.5em;
  font-size: var(--vscode-font-size);
}
</style>
