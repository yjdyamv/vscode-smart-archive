<script setup lang="ts">
import { computed } from "vue";
import type { FlatNode } from "../composables/useTree";
import { getFileIcon, formatSize, escapeHtml } from "../utils/icons";

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
const isDir = computed(() => node.value.kind === "DIRECTORY");
const isCollapsedDir = computed(() => isDir.value && node.value.collapsed === true);
const inheritCollapsed = computed(() => props.flatNode.inheritCollapsed);
const icon = computed(() => getFileIcon(node.value.name, isDir.value));
const indentPx = 16;

function indentGuides(depth: number, hasChildren: boolean): number[] {
  return Array.from({ length: depth + (hasChildren ? 1 : 0) }, (_, i) => i);
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
  if ((e.target as HTMLElement).closest(".cb")) return;
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
    :style="{ paddingLeft: depth * indentPx + 'px' }"
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
      v-for="i in indentGuides(depth, flatNode.hasChildren)"
      :key="'g' + i"
      class="guide"
      :style="{ left: i * indentPx + indentPx / 2 + 'px' }"
    ></span>
    <span class="cb" @click="onCheckClick" role="checkbox" :aria-checked="selected || undefined" :aria-label="'Select ' + node.name">
      <span class="ck" :class="{ on: selected }"></span>
    </span>
    <span
      class="ar"
      :class="{ rot: flatNode.expanded, empty: isDir && !flatNode.hasChildren }"
      role="button"
      :aria-label="flatNode.expanded ? 'Collapse ' + node.name : 'Expand ' + node.name"
      :tabindex="isDir && flatNode.hasChildren ? 0 : -1"
      @click="isDir ? onExpandClick($event) : undefined"
    >
      <span v-if="isLoading" class="ar-loading"></span>
      <span v-else-if="isDir" class="codicon codicon-chevron-right ar-icon"></span>
    </span>
    <span class="codicon ic" :class="'codicon-' + icon.codicon"></span>
    <span class="nm" :title="node.path" v-html="nameHtml"></span>
    <span v-if="!isDir && node.size > 0" class="sz">{{ formatSize(node.size) }}</span>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  height: calc(var(--vscode-font-size) * 1.85);
  line-height: calc(var(--vscode-font-size) * 1.85);
  display: flex;
  align-items: center;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  padding-right: 8px;
  transition: background 0.08s ease;
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
  width: 1px;
  background: var(--vscode-tree-indentGuidesStroke);
  opacity: 0.5;
  pointer-events: none;
}
.cb {
  width: 22px;
  flex-shrink: 0;
  text-align: center;
  cursor: pointer;
  padding: 2px 0;
}
.cb:hover .ck {
  border-color: var(--vscode-focusBorder, #007acc);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc44);
}
.ck {
  display: inline-block;
  width: calc(var(--vscode-font-size) * 1.25);
  height: calc(var(--vscode-font-size) * 1.25);
  border: 1.5px solid var(--vscode-checkbox-border, #6e7681);
  border-radius: 3px;
  background: var(--vscode-checkbox-background, transparent);
  vertical-align: middle;
  position: relative;
  transition: all 0.12s;
}
.ck.on {
  background: var(--vscode-checkbox-selectBackground, #0e639c);
  border-color: var(--vscode-checkbox-selectBorder, #007acc);
}
.ck.on::after {
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
.ar {
  width: calc(var(--vscode-font-size) * 1.3);
  flex-shrink: 0;
  text-align: center;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.1s;
}
.ar:hover {
  opacity: 1;
}
.ar-icon {
  font-size: 12px;
  transition: transform 0.15s ease;
}
.ar.rot .ar-icon {
  transform: rotate(90deg);
}
.ar.empty {
  opacity: 0.25;
  cursor: default;
}
.ar.empty:hover {
  opacity: 0.25;
}
.ar-loading {
  display: inline-block;
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--vscode-descriptionForeground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ar-spin 0.6s linear infinite;
  vertical-align: middle;
}
@keyframes ar-spin {
  to {
    transform: rotate(360deg);
  }
}
.ic {
  width: calc(var(--vscode-font-size) * 1.5);
  text-align: center;
  flex-shrink: 0;
  line-height: calc(var(--vscode-font-size) * 1.85);
  font-size: calc(var(--vscode-font-size) * 1.05);
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.sz {
  font-size: calc(var(--vscode-font-size) * 0.82);
  color: var(--vscode-descriptionForeground);
  margin-left: 10px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
:deep(mark) {
  background: var(--vscode-editor-findMatchHighlightBackground, #d4d40066);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
