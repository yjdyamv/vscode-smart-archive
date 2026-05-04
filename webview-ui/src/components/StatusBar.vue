<template>
  <div class="flex items-center gap-1.5 px-3 py-1 text-[0.85em] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-statusBar-background,var(--vscode-sideBarSectionHeader-background))] border-t border-[var(--vscode-sideBarSectionHeader-border)] flex-shrink-0">
    <button v-if="isSplit" class="btn" title="Merge split volumes into a single archive" @click="$emit('merge')"><span class="codicon codicon-merge"></span> Merge</button>
    <button v-if="canSplit && !isSplit" class="btn" title="Split into volumes" @click="$emit('split')"><span class="codicon codicon-split-horizontal"></span> Split</button>
    <button v-if="isEncrypted" class="btn" title="Remove encryption and re-pack" @click="$emit('decrypt')"><span class="codicon codicon-unlock"></span> Decrypt</button>
    <button v-if="!isEncrypted && (canSplit || isSplit)" class="btn" title="Add encryption to this archive" @click="$emit('encrypt')"><span class="codicon codicon-lock"></span> Encrypt</button>
    <button class="btn-ico" title="Test Archive Integrity" @click="$emit('test')"><span class="codicon codicon-verified"></span></button>
    <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
      <b class="text-[var(--vscode-foreground)]">{{ name }}</b> &nbsp;|&nbsp; {{ format }} &nbsp;|&nbsp; Items: <b>{{ count }}</b> | Files: <b>{{ files }}</b> | Dirs: <b>{{ dirs }}</b> | Size: <b class="text-[var(--vscode-foreground)]">{{ size }}</b>
    </span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ name: string; format: string; count: number; files: number; dirs: number; size: string; isSplit?: boolean; canSplit?: boolean; isEncrypted?: boolean }>();
defineEmits<{ (e: "test"): void; (e: "merge"): void; (e: "split"): void; (e: "encrypt"): void; (e: "decrypt"): void }>();
</script>

<style scoped>
.btn-ico { background: transparent; color: var(--vscode-foreground); border: none; padding: 2px 4px; border-radius: 2px; cursor: pointer; font-size: calc(var(--vscode-font-size) * 0.85); line-height: 1; flex-shrink: 0; }
.btn-ico:hover { background: var(--vscode-toolbar-hoverBackground); }
.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; border-radius: 2px; cursor: pointer; font-size: calc(var(--vscode-font-size) * 0.85); white-space: nowrap; }
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn .codicon { margin-right: 4px; }
</style>
