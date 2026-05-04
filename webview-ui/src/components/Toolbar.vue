<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-b border-[var(--vscode-sideBarSectionHeader-border)] bg-[var(--vscode-sideBarSectionHeader-background)] sticky top-0 z-10 flex-shrink-0">
    <div class="flex flex-wrap items-center gap-1">
      <button class="btn" :disabled="selectedCount === 0" @click="$emit('extract-selected')"><span class="codicon codicon-archive"></span> Extract</button>
      <button class="btn" :disabled="readOnly || selectedCount === 0" @click="$emit('delete-selected')"><span class="codicon codicon-trash"></span> Delete</button>
      <button class="btn" :disabled="readOnly" @click="$emit('add-files')" :title="'Add to ' + (lastAddDir || 'archive root')"><span class="codicon codicon-add"></span> Add Files</button>
      <span v-if="selectedCount > 0" class="text-[0.92em] text-[var(--vscode-descriptionForeground)]">
        <b class="text-[var(--vscode-foreground)]">{{ selectedFiles }}/{{ totalFiles }}</b> files
        <b class="text-[var(--vscode-foreground)] ml-2">{{ selectedDirs }}/{{ totalDirs }}</b> dirs
      </span>
      <button class="btn-ico" title="Expand All" @click="$emit('expand-all')"><span class="codicon codicon-expand-all"></span></button>
      <button class="btn-ico" title="Collapse All" @click="$emit('collapse-all')"><span class="codicon codicon-collapse-all"></span></button>
    </div>
    <div class="flex flex-wrap items-center gap-1">
      <span class="sort-lbl" :class="{ on: sortKey === 'name' }" @click="$emit('sort', 'name')">Name</span>
      <span class="sort-lbl" :class="{ on: sortKey === 'size' }" @click="$emit('sort', 'size')">Size</span>
      <span class="text-[0.78em] text-[var(--vscode-descriptionForeground)] whitespace-nowrap">{{ sortKey }} <span class="codicon" :class="sortAsc ? 'codicon-chevron-down' : 'codicon-chevron-up'"></span></span>
      <input class="search-input" type="text" :value="searchQuery" placeholder="Filter…" @input="$emit('search', ($event.target as HTMLInputElement).value)" />
      <button class="btn" @click="$emit('extract-all')"><span class="codicon codicon-archive"></span> Extract All</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  selectedCount: number; selectedFiles: number; selectedDirs: number;
  totalFiles: number; totalDirs: number;
  sortKey: string; sortAsc: boolean; searchQuery: string; lastAddDir: string;
  readOnly?: boolean;
}>();
defineEmits<{
  (e: "extract-all"): void; (e: "extract-selected"): void; (e: "delete-selected"): void;
  (e: "add-files"): void; (e: "copy"): void; (e: "expand-all"): void; (e: "collapse-all"): void;
  (e: "sort", key: "name" | "size"): void; (e: "search", query: string): void;
}>();
</script>

<style scoped>
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
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn:disabled { opacity: 0.5; cursor: default; }
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
.btn-ico:hover { background: var(--vscode-toolbar-hoverBackground); }
.btn .codicon { margin-right: 4px; }
.btn-ico .codicon { font-size: calc(var(--vscode-font-size) * 1.1); }
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
.search-input:focus { border-color: var(--vscode-focusBorder); }
.sort-lbl {
  cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.85);
  color: var(--vscode-descriptionForeground);
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
}
.sort-lbl:hover { color: var(--vscode-foreground); }
.sort-lbl.on { color: var(--vscode-foreground); font-weight: 600; }
</style>
