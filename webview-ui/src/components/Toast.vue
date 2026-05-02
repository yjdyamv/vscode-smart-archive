<script setup lang="ts">
defineProps<{ msg: string; ok: boolean; visible: boolean }>();
</script>
<template>
  <Transition name="fade">
    <div v-if="visible" class="fixed top-3 left-1/2 -translate-x-1/2 px-5 py-1.5 rounded text-[0.92em] z-[999] pointer-events-none"
      :class="ok ? 'bg-[var(--vscode-terminal-ansiGreen)] text-[var(--vscode-editor-background)]' : 'bg-[var(--vscode-inputValidation-errorBackground)] text-[var(--vscode-inputValidation-errorForeground)] border border-[var(--vscode-inputValidation-errorBorder)]'">
      {{ msg }}
    </div>
  </Transition>
</template>
<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
