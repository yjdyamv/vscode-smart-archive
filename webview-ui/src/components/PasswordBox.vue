<script setup lang="ts">
import { ref } from "vue";

defineProps<{ archiveName: string }>();
const emit = defineEmits<{ (e: "submit", pw: string): void }>();
const password = ref("");
const showPassword = ref(false);
const hasError = ref(false);
function submit() { if (password.value.trim()) emit("submit", password.value); }
function onKeydown(e: KeyboardEvent) { if (e.key === "Enter") submit(); }
</script>

<template>
  <div class="flex flex-col items-center justify-center h-screen gap-2.5">
    <div class="text-5xl">🔒</div>
    <div class="text-[var(--vscode-foreground)] text-[1.1em]">{{ archiveName }}</div>
    <div class="text-[var(--vscode-descriptionForeground)] text-[0.92em] mb-1">Encrypted — enter password</div>
    <div class="relative flex items-center">
      <input v-model="password" :type="showPassword ? 'text' : 'password'"
        :class="{ '!border-[var(--vscode-inputValidation-errorBorder)] shadow-[0_0_0_1px_var(--vscode-inputValidation-errorBorder)]': hasError }"
        class="bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded px-3 py-1.5 pr-9 w-[248px] focus:outline-1 focus:outline-[var(--vscode-focusBorder)] transition-colors"
        placeholder="Password" autofocus @keydown="onKeydown" />
      <button class="absolute right-1.5 top-1/2 -translate-y-1/2 bg-none border-none cursor-pointer text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] text-sm p-1 leading-none"
        @mousedown="showPassword = true" @mouseup="showPassword = false" @mouseleave="showPassword = false">👁</button>
    </div>
    <button class="btn mt-1" @click="submit">Unlock</button>
    <div class="text-[var(--vscode-inputValidation-errorForeground)] text-[0.92em] min-h-[1.4em] opacity-0 transition-opacity" :class="{ 'opacity-100': hasError }">Wrong password</div>
  </div>
</template>

<style scoped>
.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; border-radius: 2px; cursor: pointer; font-size: calc(var(--vscode-font-size) * 0.92); }
.btn:hover { background: var(--vscode-button-hoverBackground); }
</style>
