<template>
  <div class="flex items-center gap-x-3 gap-y-1 px-2 py-1.5 border-b border-[var(--vscode-sideBarSectionHeader-border)] bg-[var(--vscode-sideBarSectionHeader-background)] sticky top-0 z-10 flex-shrink-0">
    <div class="flex flex-wrap items-center gap-1">
      <button class="btn" :disabled="selectedCount === 0" @click="$emit('extract-selected')"><span class="codicon codicon-arrow-down"></span> Extract</button>
      <button class="btn" :disabled="readOnly || selectedCount === 0" @click="$emit('delete-selected')"><span class="codicon codicon-trash"></span> Delete</button>
      <button class="btn" :disabled="readOnly" @click="$emit('add-files')" :title="'Add to ' + (lastAddDir || 'archive root')"><span class="codicon codicon-add"></span> Add Files</button>
      <span class="sep"></span>
      <button class="btn" @click="$emit('extract-all')"><span class="codicon codicon-desktop-download"></span> Extract All</button>
      <button class="btn" @click="$emit('convert')"><span class="codicon codicon-arrow-swap"></span> Convert</button>
      <span class="sep"></span>
      <button class="btn-ico" title="Expand All" @click="$emit('expand-all')"><span class="codicon codicon-expand-all"></span></button>
      <button class="btn-ico" title="Collapse All" @click="$emit('collapse-all')"><span class="codicon codicon-collapse-all"></span></button>
    </div>
    <div class="flex flex-wrap items-center gap-2 ml-auto">
      <span v-if="selectedCount > 0" class="sel-count">
        <b>{{ selectedFiles }}/{{ totalFiles }}</b> files
        <b class="ml-2">{{ selectedDirs }}/{{ totalDirs }}</b> dirs
      </span>
      <span class="sep"></span>
      <span class="sort-lbl" :class="{ on: sortKey === 'name' }" @click="$emit('sort', 'name')">Name<span v-if="sortKey === 'name'" class="codicon ml-1" :class="sortAsc ? 'codicon-chevron-down' : 'codicon-chevron-up'"></span></span>
      <span class="sort-lbl" :class="{ on: sortKey === 'size' }" @click="$emit('sort', 'size')">Size<span v-if="sortKey === 'size'" class="codicon ml-1" :class="sortAsc ? 'codicon-chevron-down' : 'codicon-chevron-up'"></span></span>
      <input class="search-input" :class="{ 'search-error': regexError }" :title="regexError || ''" type="text" :value="searchQuery" :placeholder="isRegex ? 'Regex…' : 'Filter…'" @input="$emit('search', ($event.target as HTMLInputElement).value)" />
      <button class="btn-ico search-regex-btn" :class="{ on: isRegex }" :title="isRegex ? 'Switch to fuzzy search' : 'Use regular expression'" @click="$emit('toggle-regex')"><span class="codicon codicon-regex"></span></button>
      <span v-if="searchQuery && (searchMatchCount ?? 0) > 0" class="search-match">{{ searchMatchCount }} match{{ (searchMatchCount ?? 0) > 1 ? 'es' : '' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  selectedCount: number; selectedFiles: number; selectedDirs: number;
  totalFiles: number; totalDirs: number;
  sortKey: string; sortAsc: boolean; searchQuery: string; lastAddDir: string;
  isRegex?: boolean; regexError?: string;
  searchMatchCount?: number;
  readOnly?: boolean;
}>();
defineEmits<{
  (e: "extract-all"): void; (e: "extract-selected"): void; (e: "delete-selected"): void;
  (e: "add-files"): void; (e: "copy"): void; (e: "expand-all"): void; (e: "collapse-all"): void;
  (e: "sort", key: "name" | "size"): void; (e: "search", query: string): void;
  (e: "convert"): void; (e: "toggle-regex"): void;
}>();
</script>

<style scoped>
.sep {
  width: 1px; height: 18px;
  background: var(--vscode-sideBarSectionHeader-border);
  flex-shrink: 0;
}
.btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none; padding: 3px 10px; border-radius: 3px; cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.9); white-space: nowrap;
  display: inline-flex; align-items: center; gap: 5px;
  transition: background 0.12s ease;
}
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn-ico {
  background: transparent; color: var(--vscode-foreground);
  border: none; padding: 3px 5px; border-radius: 3px; cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.9); line-height: 1; flex-shrink: 0;
  transition: background 0.12s ease;
}
.btn-ico:hover { background: var(--vscode-toolbar-hoverBackground); }
.btn-ico .codicon { font-size: calc(var(--vscode-font-size) * 1.15); }
.search-input {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 3px 8px; border-radius: 3px;
  font-size: calc(var(--vscode-font-size) * 0.88);
  width: 120px; min-width: 80px; max-width: 200px; outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--vscode-focusBorder); }
.search-input.search-error { border-color: #e51400; box-shadow: 0 0 0 1px #e5140033; }
.search-regex-btn.on { color: var(--vscode-focusBorder, #007acc); background: var(--vscode-toolbar-hoverBackground); }
.search-match {
  font-size: calc(var(--vscode-font-size) * 0.78);
  color: var(--vscode-descriptionForeground); white-space: nowrap;
}
.sort-lbl {
  cursor: pointer; font-size: calc(var(--vscode-font-size) * 0.85);
  color: var(--vscode-descriptionForeground);
  padding: 2px 6px; border-radius: 3px; white-space: nowrap;
  display: inline-flex; align-items: center;
  transition: color 0.12s, background 0.12s;
}
.sort-lbl:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
.sort-lbl.on { color: var(--vscode-foreground); font-weight: 600; background: var(--vscode-toolbar-hoverBackground); }
.sel-count {
  font-size: calc(var(--vscode-font-size) * 0.82);
  color: var(--vscode-descriptionForeground); white-space: nowrap;
}
.sel-count b { color: var(--vscode-foreground); }
</style>
