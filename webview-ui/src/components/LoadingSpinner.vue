<template>
  <div class="flex flex-col items-center justify-center h-screen gap-3">
    <div class="spinner"></div>
    <span class="text-[var(--vscode-descriptionForeground)] text-[0.92em]">{{ msg }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ msg: string }>();
</script>

<style scoped>
.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  border-top-color: var(--vscode-progressBar-background, #007acc);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
