<template>
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 border-b border-[var(--vscode-sideBarSectionHeader-border)] bg-[var(--vscode-sideBarSectionHeader-background)] sticky top-0 z-10 flex-shrink-0"
  >
    <div class="flex flex-wrap items-center gap-1">
      <button
        class="btn"
        :disabled="selectedCount === 0"
        v-tip="ui('ui.extractSelected')"
        @click="$emit('extract-selected')"
      >
        <span class="codicon codicon-arrow-down"></span
        ><span class="btn-lbl">{{ ui("ui.extract") }}</span>
      </button>
      <button
        class="btn"
        :disabled="readOnly || selectedCount === 0"
        v-tip="ui('ui.delete')"
        @click="$emit('delete-selected')"
      >
        <span class="codicon codicon-trash"></span
        ><span class="btn-lbl">{{ ui("ui.delete") }}</span>
      </button>
      <button
        class="btn"
        :disabled="readOnly"
        @click="$emit('add-files')"
        v-tip="ui('ui.addTo') + (lastAddDir || ui('ui.archiveRoot'))"
      >
        <span class="codicon codicon-add"></span
        ><span class="btn-lbl">{{ ui("ui.addFiles") }}</span>
      </button>
      <span class="sep"></span>
      <button class="btn" v-tip="ui('ui.extractAll')" @click="$emit('extract-all')">
        <span class="codicon codicon-desktop-download"></span
        ><span class="btn-lbl">{{ ui("ui.extractAll") }}</span>
      </button>
      <button class="btn" v-tip="ui('ui.convert')" @click="$emit('convert')">
        <span class="codicon codicon-arrow-swap"></span
        ><span class="btn-lbl">{{ ui("ui.convert") }}</span>
      </button>
      <span class="sep"></span>
      <button class="btn-ico" v-tip="ui('ui.expandAll')" @click="$emit('expand-all')">
        <span class="codicon codicon-expand-all"></span>
      </button>
      <button class="btn-ico" v-tip="ui('ui.collapseAll')" @click="$emit('collapse-all')">
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
      <div class="flex flex-col min-w-[140px] max-w-[320px] flex-1 items-stretch">
        <div class="search-box" :class="{ 'search-on': !!searchQuery, 'search-error': regexError }">
          <span class="codicon codicon-search search-ico"></span>
          <input
            class="search-input"
            :value="searchQuery"
            :placeholder="ui('ui.searchPlaceholder')"
            v-tip="regexError || ui('ui.searchTitle')"
            @input="$emit('search', ($event.target as HTMLInputElement).value)"
            @keydown.esc="onEsc"
          />
          <span class="search-mode" role="group" aria-label="Search mode">
            <button
              class="search-mode-btn"
              :class="{ on: !isRegex }"
              :aria-pressed="!isRegex"
              v-tip="ui('ui.fuzzySearch')"
              @click="setMode(false)"
            >
              <span class="codicon codicon-filter"></span
              ><span class="btn-lbl">{{ ui("ui.filterMode") }}</span>
            </button>
            <button
              class="search-mode-btn"
              :class="{ on: isRegex }"
              :aria-pressed="isRegex"
              v-tip="ui('ui.useRegex')"
              @click="setMode(true)"
            >
              <span class="codicon codicon-regex"></span
              ><span class="btn-lbl">{{ ui("ui.regexMode") }}</span>
            </button>
          </span>
          <button
            v-if="searchQuery"
            class="btn-ico search-clear"
            v-tip="ui('ui.clearSearchTitle')"
            @click="clearSearch"
          >
            <span class="codicon codicon-close"></span>
          </button>
        </div>
        <span v-if="regexError" class="search-error-msg">{{ regexError }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ui } from "../composables/useUi";
const props = defineProps<{
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
  readOnly?: boolean;
}>();
const emit = defineEmits<{
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

function setMode(regex: boolean): void {
  if (props.isRegex !== regex) emit("toggle-regex");
}

function clearSearch(e: MouseEvent): void {
  emit("search", "");
  (e.target as HTMLElement).blur?.();
}

function onEsc(e: KeyboardEvent): void {
  emit("search", "");
  (e.target as HTMLElement).blur();
}
</script>
