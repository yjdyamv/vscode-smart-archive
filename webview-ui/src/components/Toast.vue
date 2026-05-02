<script setup lang="ts">
defineProps<{
  msg: string;
  ok: boolean;
  visible: boolean;
}>();
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="toast" :class="{ ok, err: !ok }">
      {{ msg }}
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 20px;
  border-radius: 4px;
  font-size: calc(var(--vscode-font-size) * 0.92);
  z-index: 999;
  pointer-events: none;
}
.toast.ok {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}
.toast.err {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
