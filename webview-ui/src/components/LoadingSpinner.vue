<script setup lang="ts">
defineProps<{ msg: string }>();
</script>

<template>
  <div class="loading">
    <div class="spinner"></div>
    {{ msg }}
  </div>
</template>

<style scoped>
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: var(--vscode-descriptionForeground);
}
.spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--vscode-panel-border);
  border-top-color: var(--vscode-progressBar-background);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 10px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
