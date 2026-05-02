import { reactive } from "vue";

export function useSelection() {
  const state = reactive({
    selected: new Set<string>(),
    anchorPath: null as string | null,
    lastAddDir: "",
  });

  function toggle(path: string): void {
    if (state.selected.has(path)) {
      state.selected.delete(path);
    } else {
      state.selected.add(path);
      if (!path.endsWith("/")) {
        const idx = path.lastIndexOf("/");
        state.lastAddDir = idx > 0 ? path.substring(0, idx) : "";
      } else {
        state.lastAddDir = path.replace(/\/$/, "");
      }
    }
  }

  function clearAll(): void {
    state.selected.clear();
    state.anchorPath = null;
  }

  function isSelected(path: string): boolean {
    return state.selected.has(path);
  }

  function getSelectedPaths(): string[] {
    return dedupPaths(state.selected);
  }

  function hasSelected(): boolean {
    return state.selected.size > 0;
  }

  return { state, toggle, clearAll, isSelected, getSelectedPaths, hasSelected };
}

function dedupPaths(s: Set<string>): string[] {
  const arr = [...s];
  const result: string[] = [];
  for (const p of arr) {
    const parts = p.replace(/\\/g, "/").split("/");
    let covered = false;
    for (let j = parts.length - 2; j >= 0; j--) {
      if (s.has(parts.slice(0, j + 1).join("/"))) {
        covered = true;
        break;
      }
    }
    if (!covered) result.push(p);
  }
  return result;
}
