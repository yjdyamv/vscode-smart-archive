<script setup lang="ts">
defineProps<{ msg: string; ok: boolean; visible: boolean }>();
</script>
<template>
  <Transition name="slide-fade">
    <div
      v-if="visible"
      class="fixed top-3 left-1/2 px-5 py-2 rounded-sa-md text-sa-lg z-toast pointer-events-none shadow-lg"
      :class="
        ok
          ? 'bg-[var(--vscode-terminal-ansiGreen)] text-[var(--vscode-editor-background)]'
          : 'bg-[var(--vscode-inputValidation-errorBackground)] text-[var(--vscode-inputValidation-errorForeground)] border border-[var(--vscode-inputValidation-errorBorder)]'
      "
      style="transform: translateX(-50%)"
    >
      {{ msg }}
    </div>
  </Transition>
</template>
<style scoped>
.slide-fade-enter-active {
  transition: all 0.25s ease-out;
}
.slide-fade-leave-active {
  transition: all 0.2s ease-in;
}
.slide-fade-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}
.slide-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-4px);
}
</style>
