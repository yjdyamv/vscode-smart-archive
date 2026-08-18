<template>
  <div
    class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 text-[0.85em] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-statusBar-background,var(--vscode-sideBarSectionHeader-background))] border-t border-[var(--vscode-sideBarSectionHeader-border)] flex-shrink-0"
  >
    <div class="flex flex-wrap items-center gap-1.5">
      <button v-if="isSplit" class="btn" :title="ui('ui.mergeTitle')" @click="$emit('merge')">
        <span class="codicon codicon-merge"></span><span class="btn-lbl">{{ ui("ui.merge") }}</span>
      </button>
      <button
        v-if="canSplit && !isSplit"
        class="btn"
        :title="ui('ui.splitTitle')"
        @click="$emit('split')"
      >
        <span class="codicon codicon-split-horizontal"></span
        ><span class="btn-lbl">{{ ui("ui.split") }}</span>
      </button>
      <template v-if="canEncrypt">
        <button
          v-if="isEncrypted"
          class="btn"
          :title="ui('ui.decryptTitle')"
          @click="$emit('decrypt')"
        >
          <span class="codicon codicon-unlock"></span
          ><span class="btn-lbl">{{ ui("ui.decrypt") }}</span>
        </button>
        <button
          v-if="!isEncrypted"
          class="btn"
          :title="ui('ui.encryptTitle')"
          @click="$emit('encrypt')"
        >
          <span class="codicon codicon-lock"></span
          ><span class="btn-lbl">{{ ui("ui.encrypt") }}</span>
        </button>
      </template>
      <button class="btn-ico" :title="ui('ui.testTitle')" @click="$emit('test')">
        <span class="codicon codicon-verified"></span>
      </button>
      <span class="sep"></span>
    </div>
    <span class="flex-1 min-w-[18em] flex flex-wrap items-center gap-x-1">
      <b class="meta-name text-[var(--vscode-foreground)] text-sa-xl whitespace-nowrap">{{
        name
      }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50">|</span>
      <span class="whitespace-nowrap">{{ format }}</span>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50">|</span>
      <span class="whitespace-nowrap"
        >{{ ui("ui.itemsLabel") }} <b>{{ count }}</b></span
      >
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50">|</span>
      <span class="whitespace-nowrap"
        >{{ ui("ui.filesLabel") }} <b>{{ files }}</b></span
      >
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50">|</span>
      <span class="whitespace-nowrap"
        >{{ ui("ui.dirsLabel") }} <b>{{ dirs }}</b></span
      >
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50">|</span>
      <span class="whitespace-nowrap">
        {{ ui("ui.sizeLabel") }}
        <b class="text-[var(--vscode-foreground)]">{{ size }}</b>
      </span>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50">|</span>
      <span class="whitespace-nowrap">
        {{ ui("ui.ratioLabel") }}
        <b class="text-[var(--vscode-foreground)]">{{
          ratio === 0 ? "—" : (ratio * 100).toFixed(2) + "%"
        }}</b>
      </span>
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
