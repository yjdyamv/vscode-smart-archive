<template>
  <div class="flex items-center gap-1.5 px-3 py-1 text-[0.85em] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-statusBar-background,var(--vscode-sideBarSectionHeader-background))] border-t border-[var(--vscode-sideBarSectionHeader-border)] flex-shrink-0">
    <button class="btn-ico" title="Test Archive Integrity" @click="$emit('test')"><span class="codicon codicon-verified"></span></button>
    <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
      <b class="text-[var(--vscode-foreground)]">{{ name }}</b> &nbsp;|&nbsp; {{ format }} &nbsp;|&nbsp; Items: <b>{{ count }}</b> | Files: <b>{{ files }}</b> | Dirs: <b>{{ dirs }}</b> | Size: <b class="text-[var(--vscode-foreground)]">{{ size }}</b>
    </span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ name: string; format: string; count: number; files: number; dirs: number; size: string }>();
defineEmits<{ (e: "test"): void }>();
</script>

<style scoped>
.btn-ico { background: transparent; color: var(--vscode-foreground); border: none; padding: 2px 4px; border-radius: 2px; cursor: pointer; font-size: calc(var(--vscode-font-size) * 0.85); line-height: 1; flex-shrink: 0; }
.btn-ico:hover { background: var(--vscode-toolbar-hoverBackground); }
</style>
