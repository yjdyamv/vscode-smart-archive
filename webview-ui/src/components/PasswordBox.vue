<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import type { ExtensionMessage } from "../types";

defineProps<{ archiveName: string }>();
const emit = defineEmits<{ (e: "submit", pw: string): void }>();
const password = ref("");
const showPassword = ref(false);
const hasError = ref(false);

function onMsg(e: MessageEvent) {
  const data = e.data as ExtensionMessage;
  if (data?.c === "pwerr") {
    hasError.value = true;
    password.value = "";
    setTimeout(() => { hasError.value = false; }, 4000);
  }
}
onMounted(() => window.addEventListener("message", onMsg));
onUnmounted(() => window.removeEventListener("message", onMsg));

function submit() {
  if (password.value.trim()) {
    hasError.value = false;
    emit("submit", password.value);
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") submit();
}
</script>

<template>
  <div class="flex flex-col items-center justify-center h-screen gap-3">
    <div class="pw-icon"><span class="codicon codicon-lock"></span></div>
    <div class="text-[var(--vscode-foreground)] text-[1.15em] font-medium">{{ archiveName }}</div>
    <div class="text-[var(--vscode-descriptionForeground)] text-[0.9em]">
      This archive is encrypted. Enter its password to continue.
    </div>
    <div class="flex items-center gap-2 mt-1">
      <div :class="{ ring: hasError }" class="pw-box">
        <input
          v-model="password"
          :type="showPassword ? 'text' : 'password'"
          class="bg-transparent text-[var(--vscode-input-foreground)] border-none px-3 py-2 w-[240px] focus:outline-none text-sm"
          placeholder="Password"
          autofocus
          @keydown="onKeydown"
        />
        <button v-if="password" class="pw-btn" @click="password = ''">
          <span class="codicon codicon-close"></span>
        </button>
        <button class="pw-btn" @click="showPassword = !showPassword">
          <span class="codicon" :class="showPassword ? 'codicon-eye-closed' : 'codicon-eye'"></span>
        </button>
      </div>
    </div>
    <button class="unlock-btn" @click="submit">Unlock</button>
    <div class="pw-error" :class="{ show: hasError }">Wrong password — please try again</div>
  </div>
</template>

<style scoped>
.pw-icon {
  font-size: 48px;
  line-height: 1;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}
.pw-box {
  display: flex;
  align-items: center;
  border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
  border-radius: 4px;
  background: var(--vscode-input-background);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.pw-box:focus-within {
  border-color: var(--vscode-focusBorder);
}
.pw-box.ring {
  border-color: #e51400;
  box-shadow: 0 0 0 1px #e5140033;
}
.pw-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--vscode-descriptionForeground);
  padding: 4px 8px;
  font-size: 14px;
  line-height: 1;
  transition: color 0.12s;
}
.pw-btn:hover {
  color: var(--vscode-foreground);
}
.unlock-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 5px 20px;
  border-radius: 3px;
  cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.95);
  transition: background 0.12s;
}
.unlock-btn:hover {
  background: var(--vscode-button-hoverBackground);
}
.pw-error {
  color: #f14c4c;
  font-size: calc(var(--vscode-font-size) * 0.88);
  min-height: 1.4em;
  opacity: 0;
  transition: opacity 0.2s;
}
.pw-error.show {
  opacity: 1;
}
</style>
