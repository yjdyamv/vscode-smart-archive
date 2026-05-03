<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{ x: number; y: number; paths: string[]; dirPath: string }>();
const emit = defineEmits<{
  (e: "close"): void; (e: "extract"): void; (e: "delete"): void;
  (e: "copy"): void; (e: "add-here"): void; (e: "new-folder"): void; (e: "rename"): void;
}>();
const lastAddDir = inject<string>("lastAddDir", "");
const dirLabel = lastAddDir ? ` → ${lastAddDir}` : " → (root)";
const menuRef = ref<HTMLElement | null>(null);
function onMouseDown(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) emit("close");
}
onMounted(() => document.addEventListener("mousedown", onMouseDown, true));
onUnmounted(() => document.removeEventListener("mousedown", onMouseDown, true));

const style = computed(() => {
  const menuW = 180; // estimated menu width
  const menuH = 250; // estimated menu height
  const x = Math.min(props.x, window.innerWidth - menuW);
  const y = Math.min(props.y, window.innerHeight - menuH);
  return { left: Math.max(x, 0) + "px", top: Math.max(y, 0) + "px" };
});
</script>

<template>
  <div ref="menuRef" class="ctxmenu" :style="style">
    <div class="cmi" @click="emit('copy')">Copy</div>
    <div class="cmi" @click="emit('extract')">Extract Selected</div>
    <div class="cmi" @click="emit('delete')">Delete</div>
    <div class="cmi" @click="emit('add-here')">Add Files Here{{ dirLabel }}</div>
    <div class="cmi" @click="emit('new-folder')">New Folder{{ dirLabel }}</div>
    <div v-if="paths.length === 1" class="cmi" @click="emit('rename')">Rename</div>
    <div class="text-[0.85em] text-[var(--vscode-descriptionForeground)] px-4 py-0.5 cursor-default">{{ paths.length }} item(s)</div>
  </div>
</template>

<style scoped>
.ctxmenu {
  position: fixed; z-index: 1000;
  background: var(--vscode-menu-background, var(--vscode-sideBar-background));
  border: 1px solid var(--vscode-menu-border, var(--vscode-sideBarSectionHeader-border));
  border-radius: 3px; padding: 2px 0; min-width: 160px;
  font-size: calc(var(--vscode-font-size) * 0.92);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.cmi { padding: 3px 16px; cursor: pointer; white-space: nowrap; }
.cmi:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
</style>
