<script setup lang="ts">
import { computed } from "vue";
import type { FlatNode } from "../types";
import { getFileIcon, formatSize, escapeHtml } from "../utils/icons";
import { INDENT_PX } from "../constants";

const props = defineProps<{
  flatNode: FlatNode;
  depth: number;
  selected: boolean;
  matchSet: Set<string>;
  searchQuery: string;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  (e: "click", shift: boolean, ctrl: boolean): void;
  (e: "dblclick"): void;
  (e: "check"): void;
  (e: "expand"): void;
  (e: "contextmenu", event: MouseEvent): void;
}>();

const node = computed(() => props.flatNode.node);
function readDescCounts(): Record<string, { files: number; dirs: number; size?: number }> {
  const el = document.getElementById("_xDescCounts");
  if (!el) return {};
  try { return JSON.parse(el.textContent ?? "{}"); } catch { return {}; }
}

const isDir = computed(() => node.value.kind === "DIRECTORY");
const isCollapsedDir = computed(() => isDir.value && node.value.collapsed === true);
const inheritCollapsed = computed(() => props.flatNode.inheritCollapsed);
const icon = computed(() => getFileIcon(node.value.name, isDir.value));
const descLabel = computed(() => {
  if (!isDir.value) return "";
  const counts = readDescCounts()[node.value.path];
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.files > 0) parts.push(`${counts.files} file${counts.files > 1 ? "s" : ""}`);
  if (counts.dirs > 0) parts.push(`${counts.dirs} dir${counts.dirs > 1 ? "s" : ""}`);
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
});

const dirSize = computed(() => {
  if (!isDir.value) return "";
  const counts = readDescCounts()[node.value.path];
  if (!counts?.size) return "";
  return formatSize(counts.size);
});

function indentGuides(depth: number, showChildGuide: boolean): number[] {
  return Array.from({ length: depth + (showChildGuide ? 1 : 0) }, (_, i) => i);
}

const nameHtml = computed(() => {
  const name = node.value.name;
  if (!props.searchQuery.trim()) return escapeHtml(name);

  const raw = props.searchQuery.trim();
  if (raw.length > 2 && raw[0] === "/" && raw.lastIndexOf("/") === raw.length - 1) {
    try {
      const pattern = raw.slice(1, -1);
      if (
        /\((?!\?[:!=]).*\)(\+|\*|\{\d+,\})\s*(\+|\*|\{\d+,\})/.test(pattern) ||
        /(\+|\*)\s*(\+|\*)/.test(pattern) ||
        pattern.length > 200
      ) {
        return escapeHtml(name);
      }
      const re = new RegExp("(" + pattern + ")", "gi");
      return escapeHtml(name).replace(re, "<mark>$1</mark>");
    } catch {
      return escapeHtml(name);
    }
  }

  const q = raw.toLowerCase();
  const lower = name.toLowerCase();
  const pos: number[] = [];
  let qi = 0;
  for (let ci = 0; ci < lower.length && qi < q.length; ci++) {
    if (lower[ci] === q[qi]) {
      pos.push(ci);
      qi++;
    }
  }
  if (pos.length === 0) return escapeHtml(name);

  let result = "";
  let last = 0;
  for (const p of pos) {
    result +=
      escapeHtml(name.substring(last, p)) + "<mark>" + escapeHtml(name.charAt(p)) + "</mark>";
    last = p + 1;
  }
  result += escapeHtml(name.substring(last));
  return result;
});

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
      v-for="i in indentGuides(depth, flatNode.hasChildren && flatNode.expanded && !isDir)"
      :key="'g' + i"
      class="guide"
      :style="{ left: i * INDENT_PX + INDENT_PX / 2 + 'px' }"
    ></span>
    <span
      class="checkbox"
      @click="onCheckClick"
      role="checkbox"
      :aria-checked="selected || undefined"
      :aria-label="'Select ' + node.name"
    >
      <span class="checkmark" :class="{ on: selected }"></span>
    </span>
    <span
      class="arrow"
      :class="{ rot: flatNode.expanded, empty: isDir && !flatNode.hasChildren }"
      role="button"
      :aria-label="flatNode.expanded ? 'Collapse ' + node.name : 'Expand ' + node.name"
      :tabindex="isDir && flatNode.hasChildren ? 0 : -1"
      @click="isDir ? onExpandClick($event) : undefined"
    >
      <span v-if="isLoading" class="arrow-loading"></span>
      <span v-else-if="isDir" class="codicon codicon-chevron-right arrow-icon"></span>
    </span>
    <span class="codicon ic" :class="'codicon-' + icon.codicon"></span>
    <span class="name" :title="node.path" v-html="nameHtml"></span>
    <span v-if="isDir" class="desc-count">{{ descLabel }}</span>
    <span v-if="isDir && dirSize" class="size">{{ dirSize }}</span>
    <span v-else-if="!isDir && node.size > 0" class="size">{{ formatSize(node.size) }}</span>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  height: var(--sa-row-height);
  line-height: var(--sa-row-height);
  display: flex;
  align-items: center;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  padding-right: 8px;
  transition: var(--sa-transition-hover);
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.row:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.row.sel {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.row.sel .guide {
  opacity: 0.4;
}
.row.noisy {
  color: var(--vscode-descriptionForeground);
}
.row.noisy:hover {
  color: var(--vscode-foreground);
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--sa-sep-width);
  background: var(--vscode-tree-indentGuidesStroke);
  opacity: 0.5;
  pointer-events: none;
}
.checkbox {
  width: 22px;
  flex-shrink: 0;
  text-align: center;
  cursor: pointer;
  padding: 2px 0;
}
.checkbox:hover .checkmark {
  border-color: var(--vscode-focusBorder, #007acc);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc44);
}
.checkmark {
  display: inline-block;
  width: var(--sa-checkmark-size);
  height: var(--sa-checkmark-size);
  border: 1.5px solid var(--vscode-checkbox-border, #6e7681);
  border-radius: var(--sa-radius);
  background: var(--vscode-checkbox-background, transparent);
  vertical-align: middle;
  position: relative;
  transition: all var(--sa-transition-fast);
}
.checkmark.on {
  background: var(--vscode-checkbox-selectBackground, #0e639c);
  border-color: var(--vscode-checkbox-selectBorder, #007acc);
}
.checkmark.on::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 42%;
  width: 28%;
  height: 52%;
  border: solid var(--vscode-checkbox-selectForeground, #2ea043);
  border-width: 0 2px 2px 0;
  transform: translate(-50%, -50%) rotate(45deg);
}
.arrow {
  width: var(--sa-arrow-width);
  flex-shrink: 0;
  text-align: center;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity var(--sa-transition-fastest);
}
.arrow:hover {
  opacity: 1;
}
.arrow-icon {
  font-size: 12px;
  line-height: 1;
  display: inline-block;
  vertical-align: middle;
  transition: transform var(--sa-transition-medium) ease;
}
.arrow.rot .arrow-icon {
  transform: rotate(90deg);
}
.arrow.empty {
  opacity: 0.25;
  cursor: default;
}
.arrow.empty:hover {
  opacity: 0.25;
}
.arrow-loading {
  display: inline-block;
  width: var(--sa-spinner-sm);
  height: var(--sa-spinner-sm);
  border: 1.5px solid var(--vscode-descriptionForeground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ar-spin var(--sa-spin-sm) linear infinite;
  vertical-align: middle;
}
@keyframes ar-spin {
  to {
    transform: rotate(360deg);
  }
}
.icon {
  width: var(--sa-icon-width);
  text-align: center;
  flex-shrink: 0;
  line-height: var(--sa-row-height);
  font-size: var(--sa-font-2xl);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.size {
  font-size: var(--sa-font-sm);
  color: var(--vscode-descriptionForeground);
  margin-left: 10px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.desc-count {
  font-size: var(--sa-font-sm);
  color: var(--vscode-descriptionForeground);
  margin-left: 6px;
  flex-shrink: 0;
  white-space: nowrap;
}
:deep(mark) {
  background: var(--vscode-editor-findMatchHighlightBackground, #d4d40066);
  color: inherit;
  border-radius: var(--sa-radius-sm);
  padding: 0 1px;
}
</style>
