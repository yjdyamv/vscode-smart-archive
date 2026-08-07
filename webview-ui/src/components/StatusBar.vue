<template>
  <div
    class="flex items-center gap-2 px-3 py-1 text-[0.85em] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-statusBar-background,var(--vscode-sideBarSectionHeader-background))] border-t border-[var(--vscode-sideBarSectionHeader-border)] flex-shrink-0"
  >
    <div class="flex items-center gap-1.5">
      <button
        v-if="isSplit"
        class="btn"
        title="Merge split volumes into a single archive"
        @click="$emit('merge')"
      >
        <span class="codicon codicon-merge"></span> Merge
      </button>
      <button
        v-if="canSplit && !isSplit"
        class="btn"
        title="Split into volumes"
        @click="$emit('split')"
      >
        <span class="codicon codicon-split-horizontal"></span> Split
      </button>
      <template v-if="canEncrypt">
        <button
          v-if="isEncrypted"
          class="btn"
          title="Remove encryption and re-pack"
          @click="$emit('decrypt')"
        >
          <span class="codicon codicon-unlock"></span> Decrypt
        </button>
        <button
          v-if="!isEncrypted"
          class="btn"
          title="Add encryption to this archive"
          @click="$emit('encrypt')"
        >
          <span class="codicon codicon-lock"></span> Encrypt
        </button>
      </template>
      <button class="btn-ico" title="Test Archive Integrity" @click="$emit('test')">
        <span class="codicon codicon-verified"></span>
      </button>
    </div>
    <span class="sep"></span>
    <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
      <b class="meta-name text-[var(--vscode-foreground)] text-sa-xl">{{ name }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      {{ format }}
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      Items:
      <b>{{ count }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      Files: <b>{{ files }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      Dirs: <b>{{ dirs }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      Size:
      <b class="text-[var(--vscode-foreground)]">{{ size }}</b>
      <span class="meta-div text-[var(--vscode-descriptionForeground)] opacity-50 mx-0.5">|</span>
      Ratio:
      <b class="text-[var(--vscode-foreground)]">{{
        ratio === 0 ? "—" : (ratio * 100).toFixed(2) + "%"
      }}</b>
    </span>
  </div>
</template>

<script setup lang="ts">
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
