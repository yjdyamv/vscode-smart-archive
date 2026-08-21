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
  selected: boolean;
  searchQuery: string;
  isLoading: boolean;
  descCounts: Record<string, DescCount>;
}>();

const emit = defineEmits<{
  (e: "click", event: MouseEvent): void;
  (e: "dblclick"): void;
  (e: "check"): void;
  (e: "expand"): void;
  (e: "contextmenu", event: MouseEvent): void;
}>();

const node = computed(() => props.flatNode.node);
const isDir = computed(() => node.value.kind === "DIRECTORY");
const icon = computed(() => getFileIcon(node.value.name, isDir.value));

// Parent folder as a muted crumb; root-level entries carry no crumb.
const crumb = computed(() => {
  const idx = node.value.path.lastIndexOf("/");
  return idx < 0 ? "" : node.value.path.substring(0, idx + 1);
});

const nameSegments = computed(() => segmentHighlight(node.value.name, props.searchQuery));
const crumbSegments = computed(() => segmentHighlight(crumb.value, props.searchQuery));

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

const sizeLabel = computed(() => {
  if (isDir.value) return "";
  return node.value.size > 0 ? formatSize(node.value.size) : "";
});

function onExpandClick(e: MouseEvent) {
  e.stopPropagation();
  emit("expand");
}
</script>

<template>
  <div
    class="row row-res"
    :class="{ dir: isDir, sel: selected }"
    :style="{ paddingLeft: flatNode.depth * INDENT_PX + 4 + 'px' }"
    :data-path="node.path"
    role="listitem"
    :aria-selected="selected || undefined"
    :aria-expanded="isDir ? flatNode.expanded : undefined"
    tabindex="-1"
    @click="emit('click', $event)"
    @dblclick="emit('dblclick')"
    @contextmenu="emit('contextmenu', $event)"
  >
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
    <span
      class="checkbox"
      @click="
        (e: MouseEvent) => {
          e.stopPropagation();
          emit('check');
        }
      "
      role="checkbox"
      :aria-checked="selected || undefined"
      :aria-label="ui('ui.select') + node.name"
    >
      <span class="checkmark" :class="{ on: selected }"></span>
    </span>
    <span class="codicon icon" :class="'codicon-' + icon.codicon"></span>
    <span class="name truncate flex-1 min-w-0" :title="node.path"
      ><template v-for="(seg, i) in nameSegments" :key="i"
        ><mark v-if="seg.mark">{{ seg.text }}</mark
        ><template v-else>{{ seg.text }}</template></template
      ></span
    >
    <span v-if="crumb" class="res-crumb truncate" :title="node.path"
      ><template v-for="(seg, i) in crumbSegments" :key="i"
        ><mark v-if="seg.mark">{{ seg.text }}</mark
        ><template v-else>{{ seg.text }}</template></template
      ></span
    >
    <span
      v-if="isDir"
      class="desc-count text-sa-sm text-[var(--vscode-descriptionForeground)] ml-2 shrink-0 whitespace-nowrap"
      >{{ descLabel }}</span
    >
    <span
      v-if="sizeLabel"
      class="size text-sa-sm text-[var(--vscode-descriptionForeground)] ml-2.5 shrink-0 tabular-nums"
      >{{ sizeLabel }}</span
    >
  </div>
</template>
