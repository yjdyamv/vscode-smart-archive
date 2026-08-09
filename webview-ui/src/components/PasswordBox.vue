<script setup lang="ts">
import { ui } from "../composables/useUi";
import { ref, watch } from "vue";
import { PW_ERROR_HIDE_MS } from "../constants";

const props = defineProps<{ archiveName: string; hasError?: boolean }>();
const emit = defineEmits<{ (e: "submit", pw: string): void }>();
const password = ref("");
const showPassword = ref(false);
const errorVisible = ref(false);

watch(
  () => props.hasError,
  (v) => {
    if (v) {
      errorVisible.value = true;
      password.value = "";
      setTimeout(() => {
        errorVisible.value = false;
      }, PW_ERROR_HIDE_MS);
    }
  },
);

function submit() {
  if (password.value.trim()) {
    errorVisible.value = false;
    emit("submit", password.value);
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") submit();
}
</script>

<template>
  <div class="flex flex-col items-center justify-center h-screen gap-3">
    <div class="text-[48px] leading-none text-[var(--vscode-descriptionForeground)] mb-1">
      <span class="codicon codicon-lock"></span>
    </div>
    <div class="text-[var(--vscode-foreground)] text-sa-2xl font-medium">{{ archiveName }}</div>
    <div class="text-[var(--vscode-descriptionForeground)] text-sa-md">
      {{ ui("ui.encryptedHint") }}
    </div>
    <div class="flex items-center gap-2 mt-1">
      <div :class="{ ring: errorVisible }" class="pw-box">
        <input
          v-model="password"
          :type="showPassword ? 'text' : 'password'"
          class="bg-transparent text-[var(--vscode-input-foreground)] border-none px-3 py-2 w-[240px] focus:outline-none text-sm"
          :placeholder="ui('ui.password')"
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
    <button class="btn !px-5 !py-1.5 !text-sa-xl" @click="submit">{{ ui("ui.unlock") }}</button>
    <div
      class="text-sa-error text-sa-md min-h-[1.4em] transition-opacity duration-200"
      :class="errorVisible ? 'opacity-100' : 'opacity-0'"
    >
      {{ ui("ui.wrongPassword") }}
    </div>
  </div>
</template>
