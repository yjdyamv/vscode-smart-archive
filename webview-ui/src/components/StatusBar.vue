<script setup lang="ts">
defineProps<{
  name: string;
  format: string;
  count: number;
  files: number;
  dirs: number;
  size: string;
}>();

defineEmits<{
  (e: "test"): void;
}>();
</script>

<template>
  <div class="props-bar">
    <button class="btn-ico" title="Test Archive Integrity" @click="$emit('test')">✅</button>
    <span class="props-info">
      <b>{{ name }}</b> &nbsp;|&nbsp; {{ format }} &nbsp;|&nbsp; Items: <b>{{ count }}</b> | Files: <b>{{ files }}</b> | Dirs: <b>{{ dirs }}</b> | Size: <b>{{ size }}</b>
    </span>
  </div>
</template>

<style scoped>
.props-bar {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: calc(var(--vscode-font-size) * 0.85);
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-statusBar-background, var(--vscode-sideBarSectionHeader-background));
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
  display: flex;
  align-items: center;
  gap: 6px;
}
.props-info {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.props-info b {
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
</style>
