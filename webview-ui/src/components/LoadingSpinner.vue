<template>
  <div class="flex flex-col items-center justify-center h-screen gap-3">
    <div class="spinner size-[var(--size-sa-spinner)]"></div>
    <span class="text-[var(--vscode-descriptionForeground)] text-sa-lg">{{ msg }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ msg: string }>();
</script>
