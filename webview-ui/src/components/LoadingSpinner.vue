<template>
  <div class="flex items-center justify-center h-screen text-[var(--vscode-descriptionForeground)]">
    <div class="w-6 h-6 border-[3px] border-[var(--vscode-panel-border)] border-t-[var(--vscode-progressBar-background)] rounded-full animate-spin mr-2.5"></div>
    {{ msg }}
  </div>
</template>

<script setup lang="ts">
defineProps<{ msg: string }>();
</script>
