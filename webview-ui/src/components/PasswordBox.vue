<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  archiveName: string;
}>();

const emit = defineEmits<{
  (e: "submit", pw: string): void;
  (e: "skip"): void;
}>();

const password = ref("");
const showPassword = ref(false);
const hasError = ref(false);

function submit() {
  if (!password.value.trim()) return;
  emit("submit", password.value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") submit();
}
</script>

<template>
  <div class="pw-box">
    <div style="font-size:3em">🔒</div>
    <div class="pw-title">{{ archiveName }}</div>
    <div class="pw-subtitle">Encrypted — enter password</div>
    <div class="pw-inp">
      <input
        v-model="password"
        :type="showPassword ? 'text' : 'password'"
        :class="{ err: hasError }"
        placeholder="Password"
        autofocus
        @keydown="onKeydown"
      />
      <button class="pw-eye" @mousedown="showPassword = true" @mouseup="showPassword = false" @mouseleave="showPassword = false">
        👁
      </button>
    </div>
    <button class="btn" @click="submit">Unlock</button>
    <button class="btn btn-skip" @click="emit('skip')">Open without password</button>
    <div class="pw-err" :class="{ on: hasError }">Wrong password</div>
  </div>
</template>

<style scoped>
.pw-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  gap: 10px;
}
.pw-title {
  color: var(--vscode-foreground);
  font-size: calc(var(--vscode-font-size) * 1.1);
}
.pw-subtitle {
  color: var(--vscode-descriptionForeground);
  font-size: calc(var(--vscode-font-size) * 0.92);
  margin-bottom: 4px;
}
.pw-inp {
  position: relative;
  display: flex;
  align-items: center;
}
.pw-inp input {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  padding: 6px 36px 6px 12px;
  border-radius: 3px;
  font-size: var(--vscode-font-size);
  width: 248px;
  transition: border-color 0.2s;
}
.pw-inp input.err {
  border-color: var(--vscode-inputValidation-errorBorder, #e51400);
  box-shadow: 0 0 0 1px var(--vscode-inputValidation-errorBorder, #e5140033);
}
.pw-inp input:focus {
  outline: 1px solid var(--vscode-focusBorder);
}
.pw-eye {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  color: var(--vscode-descriptionForeground);
  font-size: 14px;
  padding: 2px 4px;
  line-height: 1;
}
.pw-eye:hover {
  color: var(--vscode-foreground);
}
.btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 2px 8px;
  border-radius: 2px;
  cursor: pointer;
  font-size: calc(var(--vscode-font-size) * 0.92);
  margin-top: 4px;
}
.btn:hover {
  background: var(--vscode-button-hoverBackground);
}
.btn-skip {
  background: transparent;
  color: var(--vscode-descriptionForeground);
}
.pw-err {
  color: var(--vscode-inputValidation-errorForeground, #f14c4c);
  font-size: calc(var(--vscode-font-size) * 0.92);
  min-height: 1.4em;
  opacity: 0;
  transition: opacity 0.2s;
}
.pw-err.on {
  opacity: 1;
}
</style>
