<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, type ComputedRef } from "vue";
import { ui } from "../composables/useUi";

const props = defineProps<{
  x: number;
  y: number;
  paths: string[];
  dirPath: string;
  readOnly?: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "extract"): void;
  (e: "delete"): void;
  (e: "copy"): void;
  (e: "add-here"): void;
  (e: "new-folder"): void;
  (e: "rename"): void;
}>();
const lastAddDir = inject<ComputedRef<string>>(
  "lastAddDir",
  computed(() => ""),
);
const dirLabel = computed(() =>
  lastAddDir.value ? ` → ${lastAddDir.value}` : ` → ${ui("ui.root")}`,
);
const menuRef = ref<HTMLElement | null>(null);
function onMouseDown(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) emit("close");
}
onMounted(() => document.addEventListener("mousedown", onMouseDown, true));
onUnmounted(() => document.removeEventListener("mousedown", onMouseDown, true));

const style = computed(() => {
  const menuW = 180;
  const maxY = Math.max(props.y, 0);
  const x = Math.min(props.x, window.innerWidth - menuW);
  const y = Math.min(maxY, window.innerHeight - 250);
  return {
    left: Math.max(x, 0) + "px",
    top: Math.max(y, 0) + "px",
    maxHeight: Math.min(250, window.innerHeight - Math.max(y, 0) - 8) + "px",
    overflowY: "auto" as const,
  };
});

const isReadOnly = computed(() => props.readOnly);
</script>

<template>
  <div
    ref="menuRef"
    class="ctxmenu fixed z-menu bg-[var(--vscode-menu-background,var(--vscode-sideBar-background))] border border-[var(--vscode-menu-border,var(--vscode-sideBarSectionHeader-border))] rounded-sa-md py-1 min-w-[180px] text-sa-lg shadow-sa-menu"
    :style="style"
  >
    <div class="cmi" @click="emit('copy')">
      <span class="codicon codicon-copy cmi-icon"></span>{{ ui("ui.copy")
      }}<span class="cmi-shortcut">Ctrl+C</span>
    </div>
    <div class="cmi" @click="emit('extract')">
      <span class="codicon codicon-archive cmi-icon"></span>{{ ui("ui.extractSelected")
      }}<span class="cmi-shortcut">Enter</span>
    </div>
    <div class="cmi-sep"></div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="emit('rename')">
      <span class="codicon codicon-edit cmi-icon"></span>{{ ui("ui.rename")
      }}<span class="cmi-shortcut">F2</span>
    </div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="!isReadOnly && emit('delete')">
      <span class="codicon codicon-trash cmi-icon"></span>{{ ui("ui.delete")
      }}<span class="cmi-shortcut">Del</span>
    </div>
    <div class="cmi-sep"></div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="!isReadOnly && emit('add-here')">
      <span class="codicon codicon-add cmi-icon"></span>{{ ui("ui.addFilesHere") }}{{ dirLabel }}
    </div>
    <div class="cmi" :class="{ disabled: isReadOnly }" @click="!isReadOnly && emit('new-folder')">
      <span class="codicon codicon-new-folder cmi-icon"></span>{{ ui("ui.newFolder")
      }}{{ dirLabel }}
    </div>
    <div class="px-4 py-0.5 text-sa-sm text-[var(--vscode-descriptionForeground)] cursor-default">
      {{ paths.length }} {{ paths.length > 1 ? ui("ui.items") : ui("ui.item") }}
    </div>
  </div>
</template>
