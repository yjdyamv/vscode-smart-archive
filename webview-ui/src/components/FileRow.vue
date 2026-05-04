<script setup lang="ts">
import { computed } from "vue";
import type { FlatNode } from "../composables/useTree";
import { getFileIcon } from "../utils/icons";

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
const icon = computed(() => getFileIcon(node.value.name, isDir.value));
const indentPx = 16;

function indentGuides(depth: number): number[] {
  return Array.from({ length: depth }, (_, i) => i);
}

function getNameHtml(): string {
  const name = node.value.name;
  if (!props.searchQuery.trim()) return escapeHtml(name);

  // Highlight matches
  const raw = props.searchQuery.trim();
  if (raw.length > 2 && raw[0] === "/" && raw.lastIndexOf("/") === raw.length - 1) {
    try {
      const re = new RegExp("(" + raw.slice(1, -1) + ")", "gi");
      return escapeHtml(name).replace(re, "<mark>$1</mark>");
    } catch {
      return escapeHtml(name);
    }
  }

  // Fuzzy highlight
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
    result += escapeHtml(name.substring(last, p))
      + "<mark>" + escapeHtml(name.charAt(p)) + "</mark>";
    last = p + 1;
  }
  result += escapeHtml(name.substring(last));
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(size < 10 ? 1 : 0) + " " + units[i];
}

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
    :class="{ dir: isDir, sel: selected, noisy: isCollapsedDir }"
    :style="{ paddingLeft: depth * indentPx + 'px' }"
    :data-path="node.path"
    @click="onRowClick"
    @dblclick="emit('dblclick')"
    @contextmenu="emit('contextmenu', $event)"
  >
    <span
      v-for="i in indentGuides(depth)"
      :key="'g' + i"
      class="guide"
      :style="{ left: (i * indentPx + indentPx / 2) + 'px' }"
    ></span>
    <span class="cb" @click="onCheckClick">
      <span class="ck" :class="{ on: selected }"></span>
    </span>
    <span class="ar" @click="onExpandClick">
      <span v-if="isLoading" class="ar-loading"></span>
      <template v-else>{{ flatNode.hasChildren ? (flatNode.expanded ? '▼' : '▶') : isDir ? '▶' : '' }}</template>
    </span>
    <span class="codicon ic" :class="'codicon-' + icon.codicon"></span>
    <span class="nm" :title="node.path" v-html="getNameHtml()"></span>
    <span v-if="!isDir && node.size > 0" class="sz">{{ formatSize(node.size) }}</span>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  height: calc(var(--vscode-font-size) * 1.8);
  line-height: calc(var(--vscode-font-size) * 1.8);
  display: flex;
  align-items: center;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  padding-right: 8px;
  transition: background 0.1s ease;
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
.row.noisy {
  opacity: 0.55;
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--vscode-tree-indentGuidesStroke);
  pointer-events: none;
}
.cb {
  width: 20px;
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
  width: calc(var(--vscode-font-size) * 1.3);
  height: calc(var(--vscode-font-size) * 1.3);
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
  left: 26%;
  top: 12%;
  width: 30%;
  height: 55%;
  border: solid var(--vscode-checkbox-selectForeground, #2ea043);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.ck.part {
  background: var(--vscode-checkbox-selectBackground, #0e639c);
  border-color: var(--vscode-checkbox-selectBorder, #007acc);
}
.ck.part::after {
  content: "";
  position: absolute;
  left: 22%;
  top: 42%;
  width: 40%;
  height: 0;
  border-top: 2px solid var(--vscode-checkbox-selectForeground, #2ea043);
}
.ar {
  width: calc(var(--vscode-font-size) * 1.2);
  flex-shrink: 0;
  text-align: center;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
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
  to { transform: rotate(360deg); }
}
.ic {
  width: calc(var(--vscode-font-size) * 1.4);
  text-align: center;
  flex-shrink: 0;
  line-height: calc(var(--vscode-font-size) * 1.8);
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.sz {
  font-size: calc(var(--vscode-font-size) * 0.85);
  color: var(--vscode-descriptionForeground);
  margin-left: 1em;
  flex-shrink: 0;
}
:deep(mark) {
  background: var(--vscode-editor-findMatchHighlightBackground, #d4d40066);
  color: inherit;
  border-radius: 1px;
}
</style>
