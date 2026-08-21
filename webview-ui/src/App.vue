<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from "vue";
import type { TreeNodeData, ArchiveProps } from "./types";
import type { DescCount } from "./bootstrap";
import { loadInitialState } from "./bootstrap";
import { useMessage, saveState, loadState } from "./composables/useMessage";
import { useSelection } from "./composables/useSelection";
import { useSort, type SortKey } from "./composables/useSort";
import { useSearch, filterResults } from "./composables/useSearch";
import { useTreeFlatten } from "./composables/useTree";
import { useArchiveView } from "./composables/useArchiveView";
import { ui } from "./composables/useUi";
import LoadingSpinner from "./components/LoadingSpinner.vue";
import PasswordBox from "./components/PasswordBox.vue";
import Toolbar from "./components/Toolbar.vue";
import FileTree from "./components/FileTree.vue";
import SearchResults from "./components/SearchResults.vue";
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
const loadingMsg = ref(ui("ui.readingArchive"));
const readOnly = ref(false);
const isSplit = ref(false);
const canSplit = ref(false);
const isEncrypted = ref(false);
const canEncrypt = ref(false);
const pwError = ref(false);
const descCounts = ref<Record<string, DescCount>>({});

const sort = useSort();
const tree = useTreeFlatten(treeData);

// Restore persisted sort preference (search is archive-specific, don't persist)
const prefs = loadState<{ sortKey?: SortKey; sortAsc?: boolean }>();
if (prefs?.sortKey) sort.setSort(prefs.sortKey);
if (prefs?.sortAsc === false) sort.sortAsc.value = false;

watch([sort.sortKey, sort.sortAsc], () => {
  treeData.value = sort.sortNodes([...treeData.value], descCounts.value);
  saveState({ sortKey: sort.sortKey.value, sortAsc: sort.sortAsc.value });
});

watch(
  () => JSON.stringify([...tree.expandedPaths.value].sort()),
  () => post({ c: "saveExpanded", paths: [...tree.expandedPaths.value] }),
);

const visibleFlatNodes = computed(() => {
  if (search.query.value.trim()) {
    // Search shows a flat results list: direct matches only, plus the
    // contents of matched folders the user expands (see filterResults).
    return filterResults(
      tree.flatNodes.value,
      search.directMatchSet.value,
      tree.expandedPaths.value,
    );
  }
  return tree.flatNodes.value;
});

const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
const searchResultsRef = ref<InstanceType<typeof SearchResults> | null>(null);
const containerEl = computed(
  () => fileTreeRef.value?.containerEl ?? searchResultsRef.value?.containerEl ?? null,
);
const scrollToPath = (path: string) => {
  if (search.query.value.trim()) searchResultsRef.value?.scrollToPath(path);
  else fileTreeRef.value?.scrollToPath(path);
};

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
  canEncrypt,
  pwError,
  descCounts,
  containerEl,
  scrollToPath,
});

onMounted(() => {
  const cleanupMessage = av.setupMessageHandler();
  const initial = loadInitialState();

  readOnly.value = initial.readOnly;
  isSplit.value = initial.isSplit;
  canSplit.value = initial.canSplit;
  isEncrypted.value = initial.isEncrypted;
  canEncrypt.value = initial.canEncrypt;
  descCounts.value = initial.descCounts;

  try {
    if (initial.viewState === "password") {
      if (initial.props) archiveProps.value = initial.props;
      viewState.value = "password";
    } else if (initial.tree.length > 0) {
      if (initial.props) {
        archiveProps.value = initial.props;
        totalFiles.value = initial.files;
        totalDirs.value = initial.dirs;
      }
      treeData.value = sort.sortNodes(initial.tree, descCounts.value);
      viewState.value = "content";
      tree.initExpandedFromTree(undefined, initial.expanded);
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
      if (initial.toast) av.showToast(initial.toast, true);
      av.loadExpandedPaths();
    } else {
      if (initial.props) {
        archiveProps.value = initial.props;
        totalFiles.value = initial.files;
        totalDirs.value = initial.dirs;
      }
      viewState.value = "empty";
      if (selection.state.lastAddDir) selection.state.lastAddDir = "";
    }
  } catch (err) {
    viewState.value = "empty";
    av.showToast(ui("ui.failedToInit") + (err instanceof Error ? err.message : String(err)), false);
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

const emptyState = computed(() => {
  if (search.query.value.trim()) {
    return {
      icon: "codicon-search",
      title: ui("ui.noMatchingFiles"),
      hint: ui("ui.noMatchingHint"),
    };
  }
  return {
    icon: "codicon-archive",
    title: archiveProps.value?.name ?? ui("ui.archive"),
    hint: ui("ui.noFiles"),
  };
});
</script>

<template>
  <div
    class="flex flex-col h-screen bg-[var(--vscode-sideBar-background)] text-[var(--vscode-foreground)] font-[var(--vscode-font-family)] @container"
    style="font-size: var(--vscode-font-size)"
  >
    <LoadingSpinner v-if="viewState === 'loading'" :msg="loadingMsg" />
    <PasswordBox
      v-else-if="viewState === 'password'"
      :archive-name="archiveProps?.name ?? ''"
      :has-error="pwError"
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
        <FileTree
          v-if="!search.query.value.trim()"
          ref="fileTreeRef"
          :flat-nodes="visibleFlatNodes"
          :tree-data="treeData"
          :selected="selection.state.selected"
          :expanded="tree.expandedPaths.value"
          :search-query="search.query.value"
          :loading-paths="tree.loadingPaths.value"
          :desc-counts="descCounts"
          @row-click="av.handleRowClick"
          @row-dblclick="av.handleRowDblClick"
          @check-click="av.handleCheckClick"
          @expand-click="av.handleExpandClick"
          @context-menu="av.handleContextMenu"
        />
        <SearchResults
          v-else-if="visibleFlatNodes.length > 0"
          ref="searchResultsRef"
          :flat-nodes="visibleFlatNodes"
          :selected="selection.state.selected"
          :search-query="search.query.value"
          :loading-paths="tree.loadingPaths.value"
          :desc-counts="descCounts"
          @row-click="av.handleRowClick"
          @row-dblclick="av.handleRowDblClick"
          @check-click="av.handleCheckClick"
          @expand="av.handleExpandClick"
          @context-menu="av.handleContextMenu"
        />
        <div
          v-else
          class="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--vscode-descriptionForeground)]"
        >
          <div class="text-[56px] leading-none opacity-35">
            <span class="codicon" :class="emptyState.icon"></span>
          </div>
          <div class="text-sa-xl text-[var(--vscode-foreground)]">{{ emptyState.title }}</div>
          <div class="text-sa-base opacity-70">{{ emptyState.hint }}</div>
          <div class="text-sa-sm opacity-60">
            {{ search.isRegex.value ? ui("ui.filteringRegex") : ui("ui.filteringFuzzy") }}
          </div>
          <button class="btn mt-1 !px-3 !py-1 !text-sa-sm" @click="av.onSearch('')">
            <span class="codicon codicon-close"></span>{{ ui("ui.clear") }}
          </button>
        </div>
      </template>
      <div
        v-else-if="viewState === 'empty'"
        class="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--vscode-descriptionForeground)]"
      >
        <div class="text-[56px] leading-none opacity-35">
          <span class="codicon" :class="emptyState.icon"></span>
        </div>
        <div class="text-sa-xl text-[var(--vscode-foreground)]">{{ emptyState.title }}</div>
        <div class="text-sa-base opacity-70">{{ emptyState.hint }}</div>
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
