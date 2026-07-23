<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, provide, watch } from "vue";
import type { TreeNodeData, ArchiveProps } from "./types";
import { useMessage } from "./composables/useMessage";
import { useSelection } from "./composables/useSelection";
import { useSort, type SortKey } from "./composables/useSort";
import { useSearch } from "./composables/useSearch";
import { useTreeFlatten } from "./composables/useTree";
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

const sort = useSort();
const tree = useTreeFlatten(treeData);

// Apply sort to treeData when sort key/direction changes
watch([sort.sortKey, sort.sortAsc], () => {
  treeData.value = sort.sortNodes([...treeData.value]);
});

// Persist expanded state to extension for cross-session recall
watch(
  () => tree.expandedPaths.value.size,
  () => {
    post({ c: "saveExpanded", paths: [...tree.expandedPaths.value] });
  },
);

const visibleFlatNodes = computed(() => {
  return tree.flatNodes.value.filter((fn) => {
    if (search.query.value.trim()) {
      return search.isVisible(fn.path);
    }
    return true;
  });
});

const searchMatchCount = computed(() => {
  if (!search.query.value.trim()) return 0;
  return search.directMatchSet.value.size;
});

const toast = reactive({ show: false, msg: "", ok: true });
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
const readOnly = ref(!!(window as any)._xReadOnly);
const isSplit = ref(!!(window as any)._xIsSplit);
const canSplit = ref(!!(window as any)._xCanSplit);
const isEncrypted = ref(!!(window as any)._xIsEncrypted);
const canEncrypt = ref(!!(window as any)._xCanEncrypt);

function showToast(msg: string, ok = true) {
  toast.msg = msg;
  toast.ok = ok;
  toast.show = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.show = false;
    },
    ok ? 1800 : 4000,
  );
}

function onToggleRegex() {
  search.toggleRegex(treeData.value);
}

function onSearch(q: string) {
  search.query.value = q;
  // Clear matchSet immediately so stale results aren't shown while debounce runs
  if (!q.trim()) search.matchSet.value = new Set();
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => search.updateSearch(q, treeData.value), 150);
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

function closeContextMenu() {
  ctxMenu.show = false;
}

function ctxExtract() {
  extSel();
  closeContextMenu();
}
function ctxDelete() {
  delSel();
  closeContextMenu();
}
function ctxCopy() {
  copySel();
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
  if (ctxMenu.paths.length === 1) renameFile(ctxMenu.paths[0]);
  closeContextMenu();
}

// Message handlers
function extAll() {
  post({ c: "extAll" });
  showToast("Extracting all files...", true);
}

function isAnyDirSelected(paths: string[]): boolean {
  for (const p of paths) {
    const node = tree.findNode(p);
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
    const node = tree.findNode(p);
    if (node && node.kind === "DIRECTORY" && node.children && node.children.length > 0) {
      const hasAnyChildSelected = node.children.some((c) =>
        selection.state.selected.has(c.path),
      );
      if (hasAnyChildSelected) {
        // User explicitly selected some children — exclude only deselected ones
        paths.add(p);
        for (const child of node.children) {
          if (!selection.state.selected.has(child.path)) {
            excludes.add(child.path);
          }
        }
      } else {
        // No children touched: directory selection means "extract everything inside"
        paths.add(p);
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

function convertFormat() {
  post({ c: "convert" });
}

function mergeVolumes() {
  post({ c: "merge" });
  showToast("Merging split volumes...", true);
}

function splitVolumes() {
  post({ c: "split" });
}

function encryptArchive() {
  post({ c: "encrypt" });
  showToast("Adding encryption...", true);
}

function decryptArchive() {
  post({ c: "decrypt" });
  showToast("Removing encryption...", true);
}

function submitPassword(pw: string) {
  post({ c: "pw", pw });
}

/** Return all visible (expanded) descendant paths of a directory node. */
function getVisibleDescendants(node: TreeNodeData): string[] {
  const prefix = node.path + "/";
  return tree.flatNodes.value
    .filter((fn) => fn.path.startsWith(prefix))
    .map((fn) => fn.path);
}

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
      // Clear previous range selection, then add the new range additively.
      // Using toggle would deselect the anchor (which was just selected by
      // the non-shift click), producing a gap at the anchor position.
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
  const node = tree.findNode(path);
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
    if (tree.loadingPaths.value.has(path)) return; // already loading
    tree.toggleExpand(path); // expand to show loading state
    tree.setLoading(path);
    post({ c: "expandDir", path });
    return;
  }

  // Empty directory - just toggle
  tree.toggleExpand(path);
}

// Selection counts — use precomputed descendant counts from the extension.
// The map is injected as window._xDescCounts during webview setup and
// covers ALL directories regardless of lazy-load state.
const descCounts = (
  (window as any)._xDescCounts as Record<string, { files: number; dirs: number }> | undefined
) ?? {};

const selectionBreakdown = computed(() => {
  let dirs = 0;
  let files = 0;

  for (const p of selection.state.selected) {
    // Deduplicate: skip nodes covered by a selected ancestor
    const parts = p.replace(/\\/g, "/").split("/");
    let covered = false;
    for (let j = parts.length - 2; j >= 0; j--) {
      if (selection.state.selected.has(parts.slice(0, j + 1).join("/"))) {
        covered = true;
        break;
      }
    }
    if (covered) continue;

    const node = tree.nodeMap.value.get(p);
    if (!node) continue;

    if (node.kind === "DIRECTORY") {
      dirs += 1;
      const dc = descCounts[p];
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

const selectedCount = computed(() => selectionBreakdown.value.dirs + selectionBreakdown.value.files);

onMounted(() => {
  // Register message handler first — must run for all view states
  // including password, so that pwerr/err toasts reach the UI.
  const cleanupMessage = onMessage((msg) => {
    switch (msg.c) {
      case "ok":
        showToast(msg.t as string, true);
        viewState.value = "content";
        break;
      case "err":
        showToast(msg.t as string, false);
        viewState.value = "content";
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
        showToast((msg.t as string) || "Wrong password", false);
        break;
      case "encState":
        isEncrypted.value = !!(msg.v as boolean);
        break;
      case "dirChildren": {
        const parentPath = msg.path as string;
        const children = msg.children as TreeNodeData[];
        if (parentPath && Array.isArray(children)) {
          const childPaths = tree.insertChildren(parentPath, children);
          // Auto-expand non-collapsed child directories within depth limit
          for (const c of children) {
            if (c.kind === "DIRECTORY" && (c.hasMore || (c.children?.length ?? 0) > 0)) {
              if (!c.collapsed && tree.shouldAutoExpandChild(c.path)) {
                tree.expandedPaths.value.add(c.path);
              }
            }
          }
          // Auto-select newly visible children if parent is selected
          if (selection.state.selected.has(parentPath)) {
            for (const childPath of childPaths) {
              selection.state.selected.add(childPath);
            }
          }
          // Chain-load any restored expanded directories that just appeared
          loadExpandedPaths();
        }
        break;
      }
      default:
        console.warn("Unknown message type:", msg.c);
        break;
    }
  });

  // Initialize tree / view state after message handler is registered
  try {
    const rawTree = window._xTree ?? [];
    const props = window._xProps;
    const files = window._xFiles ?? 0;
    const dirs = window._xDirs ?? 0;
    const initView = window._xViewState;

    if (initView === "password") {
      if (props) archiveProps.value = props;
      viewState.value = "password";
    } else if (rawTree.length > 0) {
      if (props) {
        archiveProps.value = props;
        totalFiles.value = files;
        totalDirs.value = dirs;
      }
      treeData.value = sort.sortNodes(rawTree);
      viewState.value = "content";
      tree.initExpandedFromTree();
      const validPaths = new Set(tree.nodeMap.value.keys());
      const filtered = new Set([...selection.state.selected].filter((p) => validPaths.has(p)));
      if (filtered.size !== selection.state.selected.size) {
        selection.state.selected = filtered;
      }
      if (selection.state.lastAddDir) {
        const dir = selection.state.lastAddDir;
        if (!validPaths.has(dir)) {
          let stillValid = false;
          const prefix = dir + "/";
          for (const p of validPaths) {
            if (p.startsWith(prefix)) {
              stillValid = true;
              break;
            }
          }
          if (!stillValid) {
            let idx = dir.lastIndexOf("/");
            while (idx > 0) {
              if (validPaths.has(dir.substring(0, idx))) {
                stillValid = true;
                break;
              }
              idx = dir.lastIndexOf("/", idx - 1);
            }
          }
          if (!stillValid) selection.state.lastAddDir = "";
        }
      }
      const toastMsg = window._xToast;
      if (toastMsg) showToast(toastMsg, true);
      loadExpandedPaths();
    } else {
      if (props) {
        archiveProps.value = props;
        totalFiles.value = files;
        totalDirs.value = dirs;
      }
      viewState.value = "empty";
      if (selection.state.lastAddDir) {
        selection.state.lastAddDir = "";
      }
    }
  } catch (err) {
    viewState.value = "empty";
    showToast(
      "Failed to initialize archive view: " + (err instanceof Error ? err.message : String(err)),
      false,
    );
  }

  document.addEventListener("keydown", handleKeyboard);

  onUnmounted(() => {
    cleanupMessage();
    document.removeEventListener("keydown", handleKeyboard);
    if (toastTimer) clearTimeout(toastTimer);
    if (searchDebounce) clearTimeout(searchDebounce);
  });
});

function handleKeyboard(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    tree.expandAll();
    loadExpandedPaths();
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
  const targetIsDir = flatList[idx].node.kind === "DIRECTORY";
  if (!shift) {
    selection.clearAll();
  }
  selection.toggle(targetPath, targetIsDir);
  selection.state.anchorPath = targetPath;
}

provide("selection", selection);
provide("tree", tree);
provide("search", search);
provide("sort", sort);
provide("postMessage", post);
provide("showToast", showToast);
provide(
  "lastAddDir",
  computed(() => selection.state.lastAddDir || ""),
);
</script>

<template>
  <div
    class="flex flex-col h-screen text-[var(--vscode-foreground)] bg-[var(--vscode-sideBar-background)] font-[var(--vscode-font-family)]"
    style="font-size: var(--vscode-font-size)"
  >
    <LoadingSpinner v-if="viewState === 'loading'" :msg="loadingMsg" />
    <PasswordBox
      v-else-if="viewState === 'password'"
      :archive-name="archiveProps?.name ?? ''"
      @submit="submitPassword"
    />
    <template v-else>
      <Toolbar
        :read-only="readOnly"
        :selected-count="selectedCount"
        :selected-files="selectionBreakdown.files"
        :selected-dirs="selectionBreakdown.dirs"
        :total-files="totalFiles"
        :total-dirs="totalDirs"
        :sort-key="sort.sortKey.value"
        :sort-asc="sort.sortAsc.value"
        :search-query="search.query.value"
        :is-regex="search.isRegex.value"
        :regex-error="search.regexError.value"
        :search-match-count="searchMatchCount"
        :last-add-dir="selection.state.lastAddDir"
        @extract-all="extAll"
        @extract-selected="extSel"
        @delete-selected="delSel"
        @add-files="addFiles"
        @copy="copySel"
        @expand-all="
          tree.expandAll();
          loadExpandedPaths();
        "
        @collapse-all="tree.collapseAll"
        @sort="(k: SortKey) => sort.setSort(k)"
        @search="onSearch"
        @toggle-regex="onToggleRegex"
        @convert="convertFormat"
      />
      <template v-if="viewState === 'content'">
        <div
          v-if="search.query.value.trim() && visibleFlatNodes.length === 0"
          class="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--vscode-descriptionForeground)] text-sm"
        >
          <div>No matching files</div>
          <div class="text-xs opacity-50">Try adjusting your search terms or clear the query</div>
        </div>
        <FileTree
          v-else
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
      </template>
      <div
        v-else
        class="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--vscode-descriptionForeground)]"
      >
        <template v-if="search.query.value.trim()">
          <div class="empty-icon"><span class="codicon codicon-search"></span></div>
          <div class="text-sm opacity-70">No matching files</div>
          <div class="text-xs opacity-50 mt-1">
            Try adjusting your search terms or clear the query
          </div>
        </template>
        <template v-else>
          <div class="empty-icon"><span class="codicon codicon-archive"></span></div>
          <div class="text-[1.1em] text-[var(--vscode-foreground)]">
            {{ archiveProps?.name ?? "Archive" }}
          </div>
          <div class="text-sm opacity-70">No files to display</div>
        </template>
      </div>
      <StatusBar
        v-if="archiveProps"
        :name="archiveProps.name"
        :format="archiveProps.format"
        :count="archiveProps.count"
        :files="totalFiles"
        :dirs="totalDirs"
        :size="archiveProps.size"
        :is-split="isSplit"
        :can-split="canSplit"
        :is-encrypted="isEncrypted"
        :can-encrypt="canEncrypt"
        @test="testArchive"
        @merge="mergeVolumes"
        @split="splitVolumes"
        @encrypt="encryptArchive"
        @decrypt="decryptArchive"
      />
    </template>

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

<style scoped>
.empty-icon {
  font-size: 56px;
  line-height: 1;
  opacity: 0.35;
}
</style>
