<script setup lang="ts">
import { ref, computed } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { FlatNode } from "../types";
import type { DescCount } from "../bootstrap";
import { VIRTUAL_OVERSCAN } from "../constants";
import { resolveRowHeight } from "../utils/dom";
import SearchResultRow from "./SearchResultRow.vue";

/**
 * Search results — a flat, virtualized list of the entries that matched the
 * query directly. Rows carry their own path crumb for context, replacing the
 * tree view (whose ancestor rows and indentation don't suit a filtered list).
 * Matched folders can be expanded in place via their chevron (or dbl-click)
 * to drill into their contents.
 */
const props = defineProps<{
  flatNodes: FlatNode[];
  selected: Set<string>;
  searchQuery: string;
  loadingPaths: Set<string>;
  descCounts: Record<string, DescCount>;
}>();

const emit = defineEmits<{
  (e: "row-click", path: string, isDir: boolean, shift: boolean, ctrl: boolean): void;
  (e: "row-dblclick", path: string, isDir: boolean): void;
  (e: "check-click", path: string): void;
  (e: "expand", path: string): void;
  (e: "context-menu", event: MouseEvent, path: string, dirPath: string): void;
}>();

const containerRef = ref<HTMLElement | null>(null);

defineExpose({
  containerEl: containerRef,
  scrollToPath: (path: string) => {
    const idx = props.flatNodes.findIndex((f) => f.path === path);
    if (idx >= 0) {
      virtualizer.value.scrollToIndex(idx, { align: "auto" });
      return;
    }
    const el = document.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  },
});

const rowHeight = computed(() => resolveRowHeight());

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.flatNodes.length,
    getScrollElement: () => containerRef.value,
    estimateSize: () => rowHeight.value,
    overscan: VIRTUAL_OVERSCAN,
  })),
);

const virtualItems = computed(() => virtualizer.value.getVirtualItems());

function onRowClick(e: MouseEvent, fn: FlatNode) {
  if ((e.target as HTMLElement).closest(".checkbox")) return;
  emit("row-click", fn.path, fn.node.kind === "DIRECTORY", e.shiftKey, e.ctrlKey || e.metaKey);
}

function onRowContextMenu(e: MouseEvent, fn: FlatNode) {
  const dirPath =
    fn.node.kind === "DIRECTORY"
      ? fn.path
      : fn.path.includes("/")
        ? fn.path.substring(0, fn.path.lastIndexOf("/"))
        : "";
  emit("context-menu", e, fn.path, dirPath);
}
</script>

<template>
  <div
    ref="containerRef"
    class="flex-1 overflow-y-auto overflow-x-hidden relative pb-[50vh] @container"
    role="list"
  >
    <div class="relative w-full" :style="{ height: virtualizer.getTotalSize() + 'px' }">
      <div
        v-for="item in virtualItems"
        :key="flatNodes[item.index].path"
        :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: rowHeight + 'px',
          transform: `translateY(${item.start}px)`,
        }"
      >
        <SearchResultRow
          :flat-node="flatNodes[item.index]"
          :selected="selected.has(flatNodes[item.index].path)"
          :search-query="searchQuery"
          :is-loading="loadingPaths.has(flatNodes[item.index].path)"
          :desc-counts="descCounts"
          @click="(e: MouseEvent) => onRowClick(e, flatNodes[item.index])"
          @dblclick="
            emit(
              'row-dblclick',
              flatNodes[item.index].path,
              flatNodes[item.index].node.kind === 'DIRECTORY',
            )
          "
          @check="emit('check-click', flatNodes[item.index].path)"
          @expand="emit('expand', flatNodes[item.index].path)"
          @contextmenu="(e: MouseEvent) => onRowContextMenu(e, flatNodes[item.index])"
        />
      </div>
    </div>
  </div>
</template>
