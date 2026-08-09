<script setup lang="ts">
import { computed } from "vue";
import type { FlatNode } from "../types";
import { getFileIcon, formatSize } from "../utils/icons";
import { INDENT_PX } from "../constants";
import { segmentHighlight } from "../composables/useSearch";
import { ui } from "../composables/useUi";
import type { DescCount } from "../bootstrap";

const props = defineProps<{
  flatNode: FlatNode;
  depth: number;
  selected: boolean;
  searchQuery: string;
  isLoading: boolean;
  descCounts: Record<string, DescCount>;
}>();

const emit = defineEmits<{
  (e: "click", shift: boolean, ctrl: boolean): void;
  (e: "dblclick"): void;
  (e: "check"): void;
  (e: "expand"): void;
  (e: "contextmenu", event: MouseEvent): void;
}>();

const node = computed(() => props.flatNode.node);

const isDir = computed(() => node.value.kind === "DIRECTORY");
const inheritCollapsed = computed(() => props.flatNode.inheritCollapsed);
const icon = computed(() => getFileIcon(node.value.name, isDir.value));
const descLabel = computed(() => {
  if (!isDir.value) return "";
  const counts = props.descCounts[node.value.path];
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.files > 0)
    parts.push(`${counts.files} ${counts.files > 1 ? ui("ui.selFiles") : ui("ui.file")}`);
  if (counts.dirs > 0)
    parts.push(`${counts.dirs} ${counts.dirs > 1 ? ui("ui.selDirs") : ui("ui.dir")}`);
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
});

const dirSize = computed(() => {
  if (!isDir.value) return "";
  const counts = props.descCounts[node.value.path];
  if (!counts?.size) return "";
  return formatSize(counts.size);
});

// Split the name into plain / highlighted segments, rendered with {{ }} in the
// template (Vue auto-escapes), so no v-html and no manual HTML escaping — an
// attacker-controlled entry name cannot inject markup.
const nameSegments = computed(() => segmentHighlight(node.value.name, props.searchQuery));

function onRowClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest(".checkbox")) return;
  emit("click", e.shiftKey, e.ctrlKey || e.metaKey);
}

function onCheckClick(e: MouseEvent) {
  e.stopPropagation();
  emit("check");
}

function onExpandClick(e: MouseEvent) {
  e.stopPropagation();
  emit("expand");
}
</script>

<template>
  <div
    class="row"
    :class="{ dir: isDir, sel: selected, noisy: inheritCollapsed }"
    :style="{ paddingLeft: depth * INDENT_PX + 'px' }"
    :data-path="node.path"
    role="treeitem"
    :aria-expanded="isDir ? flatNode.expanded : undefined"
    :aria-selected="selected || undefined"
    :aria-level="depth + 1"
    tabindex="-1"
    @click="onRowClick"
    @dblclick="emit('dblclick')"
    @contextmenu="emit('contextmenu', $event)"
  >
    <span
      v-for="i in depth"
      :key="'g' + i"
      class="guide"
      :style="{ left: i * INDENT_PX + INDENT_PX / 2 + 'px' }"
    ></span>
    <span
      class="checkbox"
      @click="onCheckClick"
      role="checkbox"
      :aria-checked="selected || undefined"
      :aria-label="ui('ui.select') + node.name"
    >
      <span class="checkmark" :class="{ on: selected }"></span>
    </span>
    <span
      class="arrow"
      :class="{ rot: flatNode.expanded, empty: isDir && !flatNode.hasChildren }"
      role="button"
      :aria-label="(flatNode.expanded ? ui('ui.collapse') : ui('ui.expand')) + node.name"
      :tabindex="isDir && flatNode.hasChildren ? 0 : -1"
      @click="isDir ? onExpandClick($event) : undefined"
    >
      <span v-if="isLoading" class="spinner-sm size-[var(--size-sa-spinner-sm)]"></span>
      <span v-else-if="isDir" class="codicon codicon-chevron-right arrow-icon"></span>
    </span>
    <span class="codicon icon" :class="'codicon-' + icon.codicon"></span>
    <span class="name truncate flex-1" :title="node.path"
      ><template v-for="(seg, i) in nameSegments" :key="i"
        ><mark v-if="seg.mark">{{ seg.text }}</mark
        ><template v-else>{{ seg.text }}</template></template
      ></span
    >
    <span
      v-if="isDir"
      class="desc-count text-sa-sm text-[var(--vscode-descriptionForeground)] ml-1.5 shrink-0 whitespace-nowrap"
      >{{ descLabel }}</span
    >
    <span
      v-if="isDir && dirSize"
      class="size text-sa-sm text-[var(--vscode-descriptionForeground)] ml-2.5 shrink-0 tabular-nums"
      >{{ dirSize }}</span
    >
    <span
      v-else-if="!isDir && node.size > 0"
      class="size text-sa-sm text-[var(--vscode-descriptionForeground)] ml-2.5 shrink-0 tabular-nums"
      >{{ formatSize(node.size) }}</span
    >
  </div>
</template>
