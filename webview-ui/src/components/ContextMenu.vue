<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{ x: number; y: number; paths: string[]; dirPath: string; readOnly?: boolean }>();
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
  const menuW = 180;
  const menuH = 250;
  const x = Math.min(props.x, window.innerWidth - menuW);
  const y = Math.min(props.y, window.innerHeight - menuH);
  return { left: Math.max(x, 0) + "px", top: Math.max(y, 0) + "px" };
});

const isReadOnly = computed(() => props.readOnly);
</script>

<template>
  <div ref="menuRef" class="ctxmenu" :style="style">
    <div class="cmi" @click="emit('copy')"><span class="codicon codicon-copy cmi-icon"></span>Copy<span class="cmi-shortcut">Ctrl+C</span></div>
    <div class="cmi" @click="emit('extract')"><span class="codicon codicon-archive cmi-icon"></span>Extract Selected<span class="cmi-shortcut">Enter</span></div>
    <div class="cmi-sep"></div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="emit('rename')"><span class="codicon codicon-edit cmi-icon"></span>Rename<span class="cmi-shortcut">F2</span></div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="!isReadOnly && emit('delete')"><span class="codicon codicon-trash cmi-icon"></span>Delete<span class="cmi-shortcut">Del</span></div>
    <div class="cmi-sep"></div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="!isReadOnly && emit('add-here')"><span class="codicon codicon-add cmi-icon"></span>Add Files Here{{ dirLabel }}</div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="!isReadOnly && emit('new-folder')"><span class="codicon codicon-new-folder cmi-icon"></span>New Folder{{ dirLabel }}</div>
    <div class="cmi-foot">{{ paths.length }} item(s)</div>
  </div>
</template>

<style scoped>
.ctxmenu {
  position: fixed; z-index: 1000;
  background: var(--vscode-menu-background, var(--vscode-sideBar-background));
  border: 1px solid var(--vscode-menu-border, var(--vscode-sideBarSectionHeader-border));
  border-radius: 4px; padding: 4px 0; min-width: 180px;
  font-size: calc(var(--vscode-font-size) * 0.92);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
.cmi {
  padding: 5px 16px; cursor: pointer; white-space: nowrap;
  display: flex; align-items: center; gap: 8px;
  transition: background 0.1s ease;
}
.cmi:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
.cmi.disabled { opacity: 0.4; cursor: default; pointer-events: none; }
.cmi.sep { height: 0; }
.cmi-icon { font-size: calc(var(--vscode-font-size) * 1.05); width: 18px; text-align: center; flex-shrink: 0; }
.cmi-sep { height: 1px; margin: 4px 12px; background: var(--vscode-menu-border, var(--vscode-sideBarSectionHeader-border)); }
.cmi-shortcut { margin-left: auto; font-size: calc(var(--vscode-font-size) * 0.8); opacity: 0.6; }
.cmi-foot { padding: 3px 16px; font-size: calc(var(--vscode-font-size) * 0.82); color: var(--vscode-descriptionForeground); cursor: default; }
</style>
