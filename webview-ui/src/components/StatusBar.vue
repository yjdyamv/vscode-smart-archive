<template>
  <div
    class="flex items-center gap-2 px-3 py-1 text-[0.85em] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-statusBar-background,var(--vscode-sideBarSectionHeader-background))] border-t border-[var(--vscode-sideBarSectionHeader-border)] flex-shrink-0"
  >
    <div class="flex items-center gap-1.5">
      <button
        v-if="isSplit"
        class="btn"
        title="Merge split volumes into a single archive"
        @click="$emit('merge')"
      >
        <span class="codicon codicon-merge"></span> Merge
      </button>
      <button
        v-if="canSplit && !isSplit"
        class="btn"
        title="Split into volumes"
        @click="$emit('split')"
      >
        <span class="codicon codicon-split-horizontal"></span> Split
      </button>
      <template v-if="canEncrypt">
        <button
          v-if="isEncrypted"
          class="btn"
          title="Remove encryption and re-pack"
          @click="$emit('decrypt')"
        >
          <span class="codicon codicon-unlock"></span> Decrypt
        </button>
        <button
          v-if="!isEncrypted"
          class="btn"
          title="Add encryption to this archive"
          @click="$emit('encrypt')"
        >
          <span class="codicon codicon-lock"></span> Encrypt
        </button>
      </template>
      <button class="btn-ico" title="Test Archive Integrity" @click="$emit('test')">
        <span class="codicon codicon-verified"></span>
      </button>
    </div>
    <span class="sep"></span>
    <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
      <b class="meta-name">{{ name }}</b>
      <span class="meta-div">|</span> {{ format }} <span class="meta-div">|</span> Items:
      <b>{{ count }}</b> <span class="meta-div">|</span> Files: <b>{{ files }}</b>
      <span class="meta-div">|</span> Dirs: <b>{{ dirs }}</b> <span class="meta-div">|</span> Size:
      <b class="text-[var(--vscode-foreground)]">{{ size }}</b>
      <span class="meta-div">|</span> Ratio:
      <b class="text-[var(--vscode-foreground)]">{{ ratio === 0 ? "—" : (ratio * 100).toFixed(2) + "%" }}</b>
    </span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  name: string;
  format: string;
  count: number;
  files: number;
  dirs: number;
  size: string;
  ratio: number;
  isSplit?: boolean;
  canSplit?: boolean;
  isEncrypted?: boolean;
  canEncrypt?: boolean;
}>();
defineEmits<{
  (e: "test"): void;
  (e: "merge"): void;
  (e: "split"): void;
  (e: "encrypt"): void;
  (e: "decrypt"): void;
}>();
</script>

<style scoped>
.sep {
  width: var(--sa-sep-width);
  height: 16px;
  background: var(--vscode-sideBarSectionHeader-border);
  flex-shrink: 0;
}
.btn-ico {
  background: transparent;
  color: var(--vscode-foreground);
  border: none;
  padding: 2px 4px;
  border-radius: var(--sa-radius);
  cursor: pointer;
  font-size: var(--sa-font-md-sm);
  line-height: 1;
  flex-shrink: 0;
  transition: var(--sa-transition-fast);
}
.btn-ico:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 3px 10px;
  border-radius: var(--sa-radius);
  cursor: pointer;
  font-size: var(--sa-font-sm);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: var(--sa-transition-fast);
}
.btn:hover {
  background: var(--vscode-button-hoverBackground);
}
.meta-name {
  color: var(--vscode-foreground);
  font-size: var(--sa-font-xl);
}
.meta-div {
  color: var(--vscode-descriptionForeground);
  opacity: 0.5;
  margin: 0 2px;
}
</style>
