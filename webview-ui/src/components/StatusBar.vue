<template>
  <div
    class="flex items-center gap-2 px-3 py-1 text-[0.85em] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-statusBar-background,var(--vscode-sideBarSectionHeader-background))] border-t border-[var(--vscode-sideBarSectionHeader-border)] flex-shrink-0"
  >
    <div class="flex items-center gap-1.5">
      <button v-if="isSplit" class="btn" :title="ui('ui.mergeTitle')" @click="$emit('merge')">
        <span class="codicon codicon-merge"></span> {{ ui("ui.merge") }}
      </button>
      <button
        v-if="canSplit && !isSplit"
        class="btn"
        :title="ui('ui.splitTitle')"
        @click="$emit('split')"
      >
        <span class="codicon codicon-split-horizontal"></span> {{ ui("ui.split") }}
      </button>
      <template v-if="canEncrypt">
        <button
          v-if="isEncrypted"
          class="btn"
          :title="ui('ui.decryptTitle')"
          @click="$emit('decrypt')"
        >
          <span class="codicon codicon-unlock"></span> {{ ui("ui.decrypt") }}
        </button>
        <button
          v-if="!isEncrypted"
          class="btn"
          :title="ui('ui.encryptTitle')"
          @click="$emit('encrypt')"
        >
          <span class="codicon codicon-lock"></span> {{ ui("ui.encrypt") }}
        </button>
      </template>
      <button class="btn-ico" :title="ui('ui.testTitle')" @click="$emit('test')">
        <span class="codicon codicon-verified"></span>
      </button>
    </div>
    <span class="sep"></span>
    <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
      <b class="meta-name text-[var(--vscode-foreground)] text-sa-xl">{{ name }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      {{ format }}
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      {{ ui("ui.itemsLabel") }}
      <b>{{ count }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      {{ ui("ui.filesLabel") }} <b>{{ files }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      {{ ui("ui.dirsLabel") }} <b>{{ dirs }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      {{ ui("ui.sizeLabel") }}
      <b class="text-[var(--vscode-foreground)]">{{ size }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      {{ ui("ui.ratioLabel") }}
      <b class="text-[var(--vscode-foreground)]">{{
        ratio === 0 ? "—" : (ratio * 100).toFixed(2) + "%"
      }}</b>
    </span>
  </div>
</template>

<script setup lang="ts">
import { ui } from "../composables/useUi";
defineProps<{
  name: string;
  format: string;
  count: number;
  files: number;
  dirs: number;
  size: string;
  ratio: number;
  isSplit?: boolean;
  canSplit?: boolean;
  isEncrypted?: boolean;
  canEncrypt?: boolean;
}>();
defineEmits<{
  (e: "test"): void;
  (e: "merge"): void;
  (e: "split"): void;
  (e: "encrypt"): void;
  (e: "decrypt"): void;
}>();
</script>
