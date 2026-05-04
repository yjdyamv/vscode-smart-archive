<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";

const props = defineProps<{ archiveName: string; wrong?: boolean }>();
const emit = defineEmits<{ (e: "submit", pw: string): void }>();
const password = ref("");
const showPassword = ref(false);
const hasError = ref(false);
watch(() => props.wrong, (v) => { hasError.value = !!v; if (v) password.value = ""; });

function onMsg(e: MessageEvent) {
  if (e.data?.c === "pwerr") {
    hasError.value = true;
    password.value = "";
    setTimeout(() => { hasError.value = false; }, 4000);
  }
}
onMounted(() => window.addEventListener("message", onMsg));
onUnmounted(() => window.removeEventListener("message", onMsg));

function submit() { if (password.value.trim()) { hasError.value = false; emit("submit", password.value); } }
function onKeydown(e: KeyboardEvent) { if (e.key === "Enter") submit(); }
</script>

<template>
  <div class="flex flex-col items-center justify-center h-screen gap-2.5">
    <div class="text-5xl"><span class="codicon codicon-lock"></span></div>
    <div class="text-[var(--vscode-foreground)] text-[1.1em]">{{ archiveName }}</div>
    <div class="text-[var(--vscode-descriptionForeground)] text-[0.92em] mb-1">Encrypted — enter password</div>
    <div class="relative flex items-center">
      <div :class="{ '!border-[#e51400] !shadow-[0_0_0_1px_#e5140033]': hasError }" class="border border-[var(--vscode-input-border)] rounded">
        <input v-model="password" :type="showPassword ? 'text' : 'password'"
          class="bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border-none rounded px-3 py-1.5 pr-9 w-[248px] focus:outline-none"
          placeholder="Password" autofocus @keydown="onKeydown" />
      </div>
      <button class="absolute right-1.5 top-1/2 -translate-y-1/2 bg-none border-none cursor-pointer text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] text-sm p-1 leading-none"
        @mousedown="showPassword = true" @mouseup="showPassword = false" @mouseleave="showPassword = false"><span class="codicon codicon-eye"></span></button>
    </div>
    <button class="btn mt-1" @click="submit">Unlock</button>
    <div :style="hasError ? 'color:#f14c4c;opacity:1' : 'opacity:0'" class="text-[0.92em] min-h-[1.4em] transition-opacity">Wrong password</div>
  </div>
</template>

<style scoped>
.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; border-radius: 2px; cursor: pointer; font-size: calc(var(--vscode-font-size) * 0.92); }
.btn:hover { background: var(--vscode-button-hoverBackground); }
</style>
