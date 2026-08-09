import type { ComputedRef, Ref } from "vue";
import type { FlatNode } from "../types";
import type { WebviewToHost } from "../protocol";
import type { SelectionController } from "./useSelection";
import type { TreeController } from "./useTree";
import { resolveRowHeight } from "../utils/dom";
import { DEFAULT_PAGE_SIZE } from "../constants";

export interface NavTarget {
  idx: number;
  path: string;
  isDir: boolean;
}

/** Pure navigation math: the row a delta move lands on, clamped to the list. */
export function computeNavigationTarget(
  flatList: FlatNode[],
  anchorPath: string | null,
  delta: number,
): NavTarget | null {
  if (!flatList.length) return null;
  let idx = anchorPath ? flatList.findIndex((f) => f.path === anchorPath) : -1;
  if (idx < 0) idx = delta > 0 ? -1 : flatList.length;
  idx = Math.max(0, Math.min(idx + delta, flatList.length - 1));
  return { idx, path: flatList[idx].path, isDir: flatList[idx].node.kind === "DIRECTORY" };
}

export interface KeyboardContext {
  visibleFlatNodes: ComputedRef<FlatNode[]>;
  selection: SelectionController;
  tree: TreeController;
  post: (msg: WebviewToHost) => void;
  scrollToPath: (path: string) => void;
  containerEl: Ref<HTMLElement | null>;
  closeContextMenu: () => void;
  /** Ctrl+A: expand everything and kick off lazy loads for restored paths. */
  expandAllAndLoad: () => void;
  /**
   * Select-all-in-progress marker: set by Ctrl+A, cleared by the drain in
   * loadExpandedPaths, by Escape, or by any manual row interaction.
   */
  selectAllPending: Ref<boolean>;
  ops: {
    extSel: () => void;
    copySel: () => void;
    delSel: () => void;
  };
}

export function createKeyboardNav(ctx: KeyboardContext) {
  function navigateRows(delta: number, shift: boolean) {
    const target = computeNavigationTarget(
      ctx.visibleFlatNodes.value,
      ctx.selection.state.anchorPath,
      delta,
    );
    if (!target) return;
    if (!shift) ctx.selection.clearAll();
    ctx.selection.toggle(target.path, target.isDir);
    ctx.selection.state.anchorPath = target.path;
    ctx.scrollToPath(target.path);
  }

  function getPageSize(): number {
    const el = ctx.containerEl.value;
    if (!el) return DEFAULT_PAGE_SIZE;
    return Math.max(1, Math.floor(el.clientHeight / resolveRowHeight()));
  }

  function handleKeyboard(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      ctx.selectAllPending.value = true;
      ctx.expandAllAndLoad();
      for (const fn of ctx.visibleFlatNodes.value) ctx.selection.state.selected.add(fn.path);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && ctx.selection.hasSelected()) {
      const ts = window.getSelection();
      if (ts && ts.toString().length > 0) return;
      e.preventDefault();
      ctx.ops.copySel();
    }
    if (e.key === "F2" && ctx.selection.state.selected.size === 1) {
      e.preventDefault();
      const paths = ctx.selection.getSelectedPaths();
      if (paths.length === 1) ctx.post({ c: "renamePrompt", path: paths[0] });
    }
    if (e.key === "Enter" && ctx.selection.hasSelected()) {
      e.preventDefault();
      ctx.ops.extSel();
    }
    if (e.key === "Escape") {
      ctx.selectAllPending.value = false;
      ctx.selection.clearAll();
      ctx.closeContextMenu();
    }
    if (e.key === " " && ctx.selection.state.anchorPath) {
      e.preventDefault();
      ctx.selection.toggle(ctx.selection.state.anchorPath);
    }
    if (e.key === "Delete" && ctx.selection.hasSelected()) {
      e.preventDefault();
      ctx.ops.delSel();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateRows(1, e.shiftKey);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateRows(-1, e.shiftKey);
    }
    if (e.key === "PageDown") {
      e.preventDefault();
      const page = getPageSize();
      ctx.containerEl.value?.scrollBy({
        top: ctx.containerEl.value.clientHeight,
        behavior: "auto",
      });
      navigateRows(page, e.shiftKey);
    }
    if (e.key === "PageUp") {
      e.preventDefault();
      const page = getPageSize();
      ctx.containerEl.value?.scrollBy({
        top: -ctx.containerEl.value.clientHeight,
        behavior: "auto",
      });
      navigateRows(-page, e.shiftKey);
    }
    if (e.key === "Home") {
      e.preventDefault();
      const flatList = ctx.visibleFlatNodes.value;
      if (!flatList.length) return;
      if (!e.shiftKey) ctx.selection.clearAll();
      ctx.selection.toggle(flatList[0].path, flatList[0].node.kind === "DIRECTORY");
      ctx.selection.state.anchorPath = flatList[0].path;
      ctx.scrollToPath(flatList[0].path);
    }
    if (e.key === "End") {
      e.preventDefault();
      const flatList = ctx.visibleFlatNodes.value;
      if (!flatList.length) return;
      const last = flatList[flatList.length - 1];
      if (!e.shiftKey) ctx.selection.clearAll();
      ctx.selection.toggle(last.path, last.node.kind === "DIRECTORY");
      ctx.selection.state.anchorPath = last.path;
      ctx.scrollToPath(last.path);
    }
  }

  return { handleKeyboard, navigateRows };
}
