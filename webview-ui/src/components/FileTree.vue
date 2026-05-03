<script setup lang="ts">
import { ref, computed } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { FlatNode } from "../composables/useTree";
import type { TreeNodeData } from "../types";
import FileRow from "./FileRow.vue";

const props = defineProps<{
  flatNodes: FlatNode[];
  treeData: TreeNodeData[];
  selected: Set<string>;
  expanded: Set<string>;
  searchQuery: string;
  matchSet: Set<string>;
  loadingPaths: Set<string>;
}>();

const emit = defineEmits<{
  (e: "row-click", path: string, isDir: boolean, shift: boolean, ctrl: boolean): void;
  (e: "row-dblclick", path: string, isDir: boolean): void;
  (e: "check-click", path: string): void;
  (e: "expand-click", path: string): void;
  (e: "context-menu", event: MouseEvent, path: string, dirPath: string): void;
}>();

const containerRef = ref<HTMLElement | null>(null);

const estimateSize = () => {
  const fontSize = typeof document !== "undefined"
    ? parseFloat(getComputedStyle(document.documentElement).fontSize)
    : 14;
  return fontSize * 1.8;
};

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.flatNodes.length,
    getScrollElement: () => containerRef.value,
    estimateSize,
    overscan: 10,
  })),
);

const virtualItems = computed(() => virtualizer.value.getVirtualItems());

function onRowContextMenu(e: MouseEvent, fn: FlatNode) {
  const dirPath = fn.node.kind === "DIRECTORY"
    ? fn.path
    : fn.path.includes("/")
      ? fn.path.substring(0, fn.path.lastIndexOf("/"))
      : "";
  emit("context-menu", e, fn.path, dirPath);
}
</script>

<template>
  <div ref="containerRef" class="flex-1 overflow-y-auto overflow-x-hidden relative pb-[50vh]">
    <div class="relative w-full" :style="{ height: virtualizer.getTotalSize() + 'px' }">
      <div
        v-for="item in virtualItems"
        :key="flatNodes[item.index].path"
        :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: estimateSize() + 'px',
          transform: `translateY(${item.start}px)`,
        }"
      >
        <FileRow
          :flat-node="flatNodes[item.index]"
          :depth="flatNodes[item.index].depth"
          :selected="selected.has(flatNodes[item.index].path)"
          :match-set="matchSet"
          :search-query="searchQuery"
          :is-loading="loadingPaths.has(flatNodes[item.index].path)"
          @click="(shift, ctrl) => emit('row-click', flatNodes[item.index].path, flatNodes[item.index].node.kind === 'DIRECTORY', shift, ctrl)"
          @dblclick="emit('row-dblclick', flatNodes[item.index].path, flatNodes[item.index].node.kind === 'DIRECTORY')"
          @check="emit('check-click', flatNodes[item.index].path)"
          @expand="emit('expand-click', flatNodes[item.index].path)"
          @contextmenu="(e: MouseEvent) => onRowContextMenu(e, flatNodes[item.index])"
        />
      </div>
    </div>
  </div>
</template>
