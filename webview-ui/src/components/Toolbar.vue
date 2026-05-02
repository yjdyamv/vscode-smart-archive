<template>
  <div class="toolbar">
    <div class="toolbar-left">
      <button class="btn" :disabled="selectedCount === 0" @click="$emit('extract-selected')">
        📦 Extract
      </button>
      <button class="btn" :disabled="selectedCount === 0" @click="$emit('delete-selected')">
        🗑 Delete
      </button>
      <button class="btn" @click="$emit('add-files')" :title="'Add to ' + (lastAddDir || 'archive root')">
        ➕ Add Files
      </button>
      <span class="sel-cnt" v-if="selectedCount > 0">
        <span>{{ selectedFiles }}/{{ totalFiles }} files</span>
        <span style="margin-left:8px">{{ selectedDirs }}/{{ totalDirs }} dirs</span>
      </span>
      <button class="btn-ico" title="Expand All" @click="$emit('expand-all')">📂</button>
      <button class="btn-ico" title="Collapse All" @click="$emit('collapse-all')">📁</button>
    </div>
    <div class="toolbar-mid">
      <span class="sort-lbl" :class="{ on: sortKey === 'name' }" @click="$emit('sort', 'name')">
        Name
      </span>
      <span class="sort-lbl" :class="{ on: sortKey === 'size' }" @click="$emit('sort', 'size')">
        Size
      </span>
      <span class="sort-indicator">{{ sortKey }} {{ sortAsc ? '↑' : '↓' }}</span>
      <input
        class="search-input"
        type="text"
        :value="searchQuery"
        placeholder="Filter…"
        @input="$emit('search', ($event.target as HTMLInputElement).value)"
      />
      <button class="btn" @click="$emit('extract-all')">📦 Extract All</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  selectedCount: number;
  selectedFiles: number;
  selectedDirs: number;
  totalFiles: number;
  totalDirs: number;
  sortKey: string;
  sortAsc: boolean;
  searchQuery: string;
  lastAddDir: string;
}>();

defineEmits<{
  (e: "extract-all"): void;
  (e: "extract-selected"): void;
  (e: "delete-selected"): void;
  (e: "add-files"): void;
  (e: "copy"): void;
  (e: "expand-all"): void;
  (e: "collapse-all"): void;
  (e: "sort", key: "name" | "size"): void;
  (e: "search", query: string): void;
}>();
</script>

<style scoped>
.toolbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
  background: var(--vscode-sideBarSectionHeader-background);
}
.toolbar-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.toolbar-mid {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 2px 8px;
  border-radius: 2px;
  cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.92);
  white-space: nowrap;
}
.btn:hover {
  background: var(--vscode-button-hoverBackground);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.sel-cnt {
  font-size: calc(var(--vscode-font-size) * 0.92);
  color: var(--vscode-descriptionForeground);
}
.sel-cnt span {
  font-weight: 600;
  color: var(--vscode-foreground);
}
.btn-ico {
  background: transparent;
  color: var(--vscode-foreground);
  border: none;
  padding: 2px 4px;
  border-radius: 2px;
  cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.85);
  line-height: 1;
  flex-shrink: 0;
}
.btn-ico:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.search-input {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 2px 6px;
  border-radius: 2px;
  font-size: calc(var(--vscode-font-size) * 0.88);
  width: 110px;
  min-width: 80px;
  outline: none;
}
.search-input:focus {
  border-color: var(--vscode-focusBorder);
}
.sort-lbl {
  cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.85);
  color: var(--vscode-descriptionForeground);
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
}
.sort-lbl:hover {
  color: var(--vscode-foreground);
}
.sort-lbl.on {
  color: var(--vscode-foreground);
  font-weight: 600;
}
.sort-indicator {
  font-size: calc(var(--vscode-font-size) * 0.78);
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}
</style>
