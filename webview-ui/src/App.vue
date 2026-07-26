<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, provide, watch } from "vue";
import type { TreeNodeData, ArchiveProps } from "./types";
import { useMessage } from "./composables/useMessage";
import { useSelection } from "./composables/useSelection";
import { useSort, type SortKey } from "./composables/useSort";
import { useSearch } from "./composables/useSearch";
import { useTreeFlatten } from "./composables/useTree";
import { useArchiveView } from "./composables/useArchiveView";
import { saveState, loadState } from "./composables/useMessage";
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
const loadingMsg = ref("Reading archive...");
const readOnly = ref(!!window._xReadOnly);
const isSplit = ref(!!window._xIsSplit);
const canSplit = ref(!!window._xCanSplit);
const isEncrypted = ref(!!window._xIsEncrypted);
const canEncrypt = ref(!!window._xCanEncrypt);

const sort = useSort();
const tree = useTreeFlatten(treeData);

// Restore persisted sort preference (search is archive-specific, don't persist)
const prefs = loadState<{ sortKey?: string; sortAsc?: boolean }>();
if (prefs?.sortKey) sort.setSort(prefs.sortKey as SortKey);
if (prefs?.sortAsc === false) sort.setSort(sort.sortKey.value);

watch([sort.sortKey, sort.sortAsc], () => {
  treeData.value = sort.sortNodes([...treeData.value]);
  saveState({ sortKey: sort.sortKey.value, sortAsc: sort.sortAsc.value });
});

watch(
  () => JSON.stringify([...tree.expandedPaths.value].sort()),
  () => post({ c: "saveExpanded", paths: [...tree.expandedPaths.value] }),
);

const visibleFlatNodes = computed(() => {
  return tree.flatNodes.value.filter((fn) => {
    if (search.query.value.trim()) return search.isVisible(fn.path);
    return true;
  });
});

const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
const containerEl = computed(() => fileTreeRef.value?.containerEl ?? null);
const scrollToPath = (path: string) => fileTreeRef.value?.scrollToPath(path);

const av = useArchiveView({
  post,
  onMessage,
  tree,
  treeData,
  selection,
  search,
  visibleFlatNodes,
  viewState,
  loadingMsg,
  archiveProps,
  totalFiles,
  totalDirs,
  readOnly,
  isSplit,
  canSplit,
  isEncrypted,
  canEncrypt,
  containerEl,
  scrollToPath,
});

onMounted(() => {
  const cleanupMessage = av.setupMessageHandler();

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
          for (const p of validPaths)
            if (p.startsWith(prefix)) {
              stillValid = true;
              break;
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
      if (toastMsg) av.showToast(toastMsg, true);
      av.loadExpandedPaths();
    } else {
      if (props) {
        archiveProps.value = props;
        totalFiles.value = files;
        totalDirs.value = dirs;
      }
      viewState.value = "empty";
      if (selection.state.lastAddDir) selection.state.lastAddDir = "";
    }
  } catch (err) {
    viewState.value = "empty";
    av.showToast(
      "Failed to initialize archive view: " + (err instanceof Error ? err.message : String(err)),
      false,
    );
  }

  document.addEventListener("keydown", av.handleKeyboard);

  onUnmounted(() => {
    cleanupMessage();
    document.removeEventListener("keydown", av.handleKeyboard);
    av.cleanup();
  });
});

provide(
  "lastAddDir",
  computed(() => selection.state.lastAddDir || ""),
);
</script>

<template>
  <div
    class="flex flex-col h-screen text-[var(--vscode-foreground)] bg-[var(--vscode-sideBar-background)] font-[var(--vscode-font-family)]"
    style="
      font-size: var(--vscode-font-size);
      --sa-radius: 3px;
      --sa-radius-md: 4px;
      --sa-radius-sm: 2px;
      --sa-sep-width: 1px;
      --sa-transition-fast: background 0.12s ease;
      --sa-transition-fastest: 0.1s;
      --sa-transition-hover: 0.08s;
      --sa-transition-medium: 0.15s;
      --sa-transition-normal: 0.2s;
      --sa-transition-slow: 0.25s;
      --sa-color-error: #e51400;
      --sa-shadow-error-ring: 0 0 0 1px #e5140033;
      --sa-shadow-menu: 0 4px 12px rgba(0, 0, 0, 0.25);
      --sa-z-toast: 999;
      --sa-z-menu: 1000;
      --sa-spinner-sm: 8px;
      --sa-spinner: 28px;
      --sa-spin-sm: 0.6s;
      --sa-spin: 0.7s;
      --sa-font-2xs: calc(var(--vscode-font-size) * 0.78);
      --sa-font-xs: calc(var(--vscode-font-size) * 0.8);
      --sa-font-sm: calc(var(--vscode-font-size) * 0.82);
      --sa-font-md-sm: calc(var(--vscode-font-size) * 0.85);
      --sa-font-md: calc(var(--vscode-font-size) * 0.88);
      --sa-font-base: calc(var(--vscode-font-size) * 0.9);
      --sa-font-lg: calc(var(--vscode-font-size) * 0.92);
      --sa-font-xl: calc(var(--vscode-font-size) * 0.95);
      --sa-font-2xl: calc(var(--vscode-font-size) * 1.05);
      --sa-font-3xl: calc(var(--vscode-font-size) * 1.15);
      --sa-checkmark-size: calc(var(--vscode-font-size) * 1.25);
      --sa-arrow-width: calc(var(--vscode-font-size) * 1.3);
      --sa-icon-width: calc(var(--vscode-font-size) * 1.5);
      --sa-row-height: calc(var(--vscode-font-size) * 1.85);
    "
  >
    <LoadingSpinner v-if="viewState === 'loading'" :msg="loadingMsg" />
    <PasswordBox
      v-else-if="viewState === 'password'"
      :archive-name="archiveProps?.name ?? ''"
      @submit="av.submitPassword"
    />
    <template v-else>
      <Toolbar
        :read-only="readOnly"
        :selected-count="av.selectedCount.value"
        :selected-files="av.selectionBreakdown.value.files"
        :selected-dirs="av.selectionBreakdown.value.dirs"
        :total-files="totalFiles"
        :total-dirs="totalDirs"
        :sort-key="sort.sortKey.value"
        :sort-asc="sort.sortAsc.value"
        :search-query="search.query.value"
        :is-regex="search.isRegex.value"
        :regex-error="search.regexError.value"
        :search-match-count="av.searchMatchCount.value"
        :last-add-dir="selection.state.lastAddDir"
        @extract-all="av.extAll"
        @extract-selected="av.extSel"
        @delete-selected="av.delSel"
        @add-files="av.addFiles"
        @copy="av.copySel"
        @expand-all="
          tree.expandAll();
          av.loadExpandedPaths();
        "
        @collapse-all="tree.collapseAll"
        @sort="(k: SortKey) => sort.setSort(k)"
        @search="av.onSearch"
        @toggle-regex="av.onToggleRegex"
        @convert="av.convertFormat"
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
          ref="fileTreeRef"
          v-else
          :flat-nodes="visibleFlatNodes"
          :tree-data="treeData"
          :selected="selection.state.selected"
          :expanded="tree.expandedPaths.value"
          :search-query="search.query.value"
          :match-set="search.matchSet.value"
          :loading-paths="tree.loadingPaths.value"
          @row-click="av.handleRowClick"
          @row-dblclick="av.handleRowDblClick"
          @check-click="av.handleCheckClick"
          @expand-click="av.handleExpandClick"
          @context-menu="av.handleContextMenu"
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
        :ratio="archiveProps.ratio"
        :is-split="isSplit"
        :can-split="canSplit"
        :is-encrypted="isEncrypted"
        :can-encrypt="canEncrypt"
        @test="av.testArchive"
        @merge="av.mergeVolumes"
        @split="av.splitVolumes"
        @encrypt="av.encryptArchive"
        @decrypt="av.decryptArchive"
      />
    </template>

    <Toast :msg="av.toast.msg" :ok="av.toast.ok" :visible="av.toast.show" />
    <ContextMenu
      v-if="av.ctxMenu.show"
      :x="av.ctxMenu.x"
      :y="av.ctxMenu.y"
      :paths="av.ctxMenu.paths"
      :dir-path="av.ctxMenu.dirPath"
      :read-only="readOnly"
      @close="av.closeContextMenu"
      @extract="av.ctxExtract"
      @delete="av.ctxDelete"
      @copy="av.ctxCopy"
      @add-here="av.ctxAddHere"
      @new-folder="av.ctxNewFolder"
      @rename="av.ctxRename"
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
