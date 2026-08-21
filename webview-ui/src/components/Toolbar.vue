<template>
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 border-b border-[var(--vscode-sideBarSectionHeader-border)] bg-[var(--vscode-sideBarSectionHeader-background)] sticky top-0 z-10 flex-shrink-0"
  >
    <div class="flex flex-wrap items-center gap-1">
      <button
        class="btn"
        :disabled="selectedCount === 0"
        :title="ui('ui.extractSelected')"
        @click="$emit('extract-selected')"
      >
        <span class="codicon codicon-arrow-down"></span
        ><span class="btn-lbl">{{ ui("ui.extract") }}</span>
      </button>
      <button
        class="btn"
        :disabled="readOnly || selectedCount === 0"
        :title="ui('ui.delete')"
        @click="$emit('delete-selected')"
      >
        <span class="codicon codicon-trash"></span
        ><span class="btn-lbl">{{ ui("ui.delete") }}</span>
      </button>
      <button
        class="btn"
        :disabled="readOnly"
        @click="$emit('add-files')"
        :title="ui('ui.addTo') + (lastAddDir || ui('ui.archiveRoot'))"
      >
        <span class="codicon codicon-add"></span
        ><span class="btn-lbl">{{ ui("ui.addFiles") }}</span>
      </button>
      <span class="sep"></span>
      <button class="btn" :title="ui('ui.extractAll')" @click="$emit('extract-all')">
        <span class="codicon codicon-desktop-download"></span
        ><span class="btn-lbl">{{ ui("ui.extractAll") }}</span>
      </button>
      <button class="btn" :title="ui('ui.convert')" @click="$emit('convert')">
        <span class="codicon codicon-arrow-swap"></span
        ><span class="btn-lbl">{{ ui("ui.convert") }}</span>
      </button>
      <span class="sep"></span>
      <button class="btn-ico" :title="ui('ui.expandAll')" @click="$emit('expand-all')">
        <span class="codicon codicon-expand-all"></span>
      </button>
      <button class="btn-ico" :title="ui('ui.collapseAll')" @click="$emit('collapse-all')">
        <span class="codicon codicon-collapse-all"></span>
      </button>
    </div>
    <div class="flex flex-wrap items-center gap-2 ml-auto">
      <span
        class="sel-count text-sa-sm text-[var(--vscode-descriptionForeground)] whitespace-nowrap"
      >
        <b class="text-[var(--vscode-foreground)]">{{ selectedFiles }}/{{ totalFiles }}</b>
        {{ ui("ui.selFiles") }}
        <b class="ml-2 text-[var(--vscode-foreground)]">{{ selectedDirs }}/{{ totalDirs }}</b>
        {{ ui("ui.selDirs") }}
      </span>
      <span class="sep"></span>
      <span class="sort-lbl" :class="{ on: sortKey === 'name' }" @click="$emit('sort', 'name')"
        >{{ ui("ui.name")
        }}<span
          v-if="sortKey === 'name'"
          class="codicon ml-1"
          :class="sortAsc ? 'codicon-chevron-down' : 'codicon-chevron-up'"
        ></span
      ></span>
      <span class="sort-lbl" :class="{ on: sortKey === 'size' }" @click="$emit('sort', 'size')"
        >{{ ui("ui.size")
        }}<span
          v-if="sortKey === 'size'"
          class="codicon ml-1"
          :class="sortAsc ? 'codicon-chevron-down' : 'codicon-chevron-up'"
        ></span
      ></span>
      <input
        class="search-input"
        :class="{ 'search-error': regexError }"
        :title="regexError || ''"
        type="text"
        :value="searchQuery"
        :placeholder="ui(isRegex ? 'ui.regex' : 'ui.filter')"
        @input="$emit('search', ($event.target as HTMLInputElement).value)"
      />
      <button
        class="btn-ico search-regex-btn"
        :class="[
          isRegex
            ? 'text-[var(--vscode-focusBorder,#007acc)] bg-[var(--vscode-toolbar-hoverBackground)]'
            : '',
        ]"
        :title="ui(isRegex ? 'ui.fuzzySearch' : 'ui.useRegex')"
        @click="$emit('toggle-regex')"
      >
        <span class="codicon codicon-regex"></span>
      </button>
      <span
        v-if="searchQuery && (searchMatchCount ?? 0) > 0"
        class="search-match text-sa-2xs text-[var(--vscode-descriptionForeground)] whitespace-nowrap"
        >{{ searchMatchCount }}
        {{ (searchMatchCount ?? 0) > 1 ? ui("ui.matches") : ui("ui.match") }}</span
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import { ui } from "../composables/useUi";
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
  isRegex?: boolean;
  regexError?: string;
  searchMatchCount?: number;
  readOnly?: boolean;
}>();
defineEmits<{
  (e: "extract-all"): void;
  (e: "extract-selected"): void;
  (e: "delete-selected"): void;
  (e: "add-files"): void;
  (e: "expand-all"): void;
  (e: "collapse-all"): void;
  (e: "sort", key: "name" | "size"): void;
  (e: "search", query: string): void;
  (e: "convert"): void;
  (e: "toggle-regex"): void;
}>();
</script>
