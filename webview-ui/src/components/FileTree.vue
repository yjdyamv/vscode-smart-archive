<script setup lang="ts">
import { ref, computed } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { FlatNode, TreeNodeData } from "../types";
import type { DescCount } from "../bootstrap";
import { VIRTUAL_OVERSCAN } from "../constants";
import { resolveRowHeight } from "../utils/dom";
import FileRow from "./FileRow.vue";

const props = defineProps<{
  flatNodes: FlatNode[];
  treeData: TreeNodeData[];
  selected: Set<string>;
  expanded: Set<string>;
  searchQuery: string;
  loadingPaths: Set<string>;
  descCounts: Record<string, DescCount>;
}>();

const emit = defineEmits<{
  (e: "row-click", path: string, isDir: boolean, shift: boolean, ctrl: boolean): void;
  (e: "row-dblclick", path: string, isDir: boolean): void;
  (e: "check-click", path: string): void;
  (e: "expand-click", path: string): void;
  (e: "context-menu", event: MouseEvent, path: string, dirPath: string): void;
}>();

const containerRef = ref<HTMLElement | null>(null);

defineExpose({
  containerEl: containerRef,
  scrollToPath: (path: string) => {
    // Virtualized rows are not all in the DOM — route through the
    // virtualizer so far-away targets (keyboard Home/End/PageNav) actually
    // scroll. The querySelector fallback covers search-filtered rows, where
    // the path may not map to a visible flat node.
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
    role="tree"
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
        <FileRow
          :flat-node="flatNodes[item.index]"
          :depth="flatNodes[item.index].depth"
          :selected="selected.has(flatNodes[item.index].path)"
          :search-query="searchQuery"
          :is-loading="loadingPaths.has(flatNodes[item.index].path)"
          :desc-counts="descCounts"
          @click="
            (shift, ctrl) =>
              emit(
                'row-click',
                flatNodes[item.index].path,
                flatNodes[item.index].node.kind === 'DIRECTORY',
                shift,
                ctrl,
              )
          "
          @dblclick="
            emit(
              'row-dblclick',
              flatNodes[item.index].path,
              flatNodes[item.index].node.kind === 'DIRECTORY',
            )
          "
          @check="emit('check-click', flatNodes[item.index].path)"
          @expand="emit('expand-click', flatNodes[item.index].path)"
          @contextmenu="(e: MouseEvent) => onRowContextMenu(e, flatNodes[item.index])"
        />
      </div>
    </div>
  </div>
</template>
