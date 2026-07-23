import { reactive, watch } from "vue";
import { saveState, loadState } from "./useMessage";
import { SAVE_DEBOUNCE_MS } from "../constants";

export function useSelection() {
  const saved = loadState<{ sel?: string[]; anchor?: string | null; lastAdd?: string }>();
  const state = reactive({
    selected: new Set<string>(saved?.sel ?? []),
    anchorPath: (saved?.anchor ?? null) as string | null,
    lastAddDir: saved?.lastAdd ?? "",
  });

  // Persist selection on change with 300ms debounce — avoids
  // O(n log n) serialization on every single toggle (e.g. Ctrl+A).
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function persistSelection() {
    saveState({
      sel: [...state.selected],
      anchor: state.anchorPath,
      lastAdd: state.lastAddDir,
    });
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      persistSelection();
    }
  }

  watch(
    () => JSON.stringify([...state.selected].sort()),
    () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persistSelection, SAVE_DEBOUNCE_MS);
    },
  );

  function toggle(path: string, isDir?: boolean): void {
    if (state.selected.has(path)) {
      state.selected.delete(path);
      // If the deselected item is the one that set lastAddDir, only clear it
      // when no other selected items share the same parent directory.
      const normPath = path.endsWith("/") ? path.replace(/\/$/, "") : path;
      const addParent = !normPath.includes("/") ? "" : normPath.slice(0, normPath.lastIndexOf("/"));
      if (state.lastAddDir === addParent || state.lastAddDir === normPath) {
        const otherSharesParent = [...state.selected]
          .filter((p) => p !== path)
          .some((p) => {
            const np = p.endsWith("/") ? p.replace(/\/$/, "") : p;
            const pParent = !np.includes("/") ? "" : np.slice(0, np.lastIndexOf("/"));
            return pParent === addParent || np === addParent;
          });
        if (!otherSharesParent) state.lastAddDir = "";
      }
    } else {
      state.selected.add(path);
      if (isDir) {
        state.lastAddDir = path.replace(/\/$/, "");
      } else if (!path.endsWith("/")) {
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
    state.lastAddDir = "";
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

  return { state, toggle, clearAll, isSelected, getSelectedPaths, hasSelected, flushSave };
}

export function dedupPaths(s: Set<string>): string[] {
  const arr = [...s];
  const result: string[] = [];
  for (const p of arr) {
    if (!isCoveredByAncestor(p, s)) result.push(p);
  }
  return result;
}

/** Check whether any ancestor of `path` exists in the given Set. */
export function isCoveredByAncestor(path: string, selected: Set<string>): boolean {
  const parts = path.replace(/\\/g, "/").split("/");
  for (let j = parts.length - 2; j >= 0; j--) {
    if (selected.has(parts.slice(0, j + 1).join("/"))) {
      return true;
    }
  }
  return false;
}
