import type { ArchiveProps, TreeNodeData } from "./types";
import { mockInitialState } from "./devMock";

export interface DescCount {
  files: number;
  dirs: number;
  size?: number;
}

/**
 * One-time read of the initial state the host injects as JSON `<script>`
 * blocks before the Vue bundle loads (see htmlRenderer.ts / setup.ts).
 * Parsed once here; every consumer receives the typed result via props or
 * context instead of touching the DOM.
 */
export interface InitialState {
  tree: TreeNodeData[];
  props: ArchiveProps | null;
  files: number;
  dirs: number;
  viewState: "password" | "content" | "empty" | null;
  toast: string | null;
  readOnly: boolean;
  isSplit: boolean;
  canSplit: boolean;
  isEncrypted: boolean;
  canEncrypt: boolean;
  descCounts: Record<string, DescCount>;
  expanded: string[];
  ui: Record<string, string>;
}

function readJson<T>(id: string): T | null {
  const el = document.getElementById(id);
  if (!el) return null;
  try {
    return JSON.parse(el.textContent ?? "") as T;
  } catch {
    return null;
  }
}

export function loadInitialState(): InitialState {
  // Browser dev preview (vite dev server): there is no VS Code host to
  // inject state, so render the mock archive instead.
  if (import.meta.env.MODE === "development") return mockInitialState();
  return {
    tree: readJson<TreeNodeData[]>("_xTree") ?? [],
    props: readJson<ArchiveProps | null>("_xProps"),
    files: readJson<number>("_xFiles") ?? 0,
    dirs: readJson<number>("_xDirs") ?? 0,
    viewState: readJson<"password" | "content" | "empty">("_xViewState"),
    toast: readJson<string>("_xToast"),
    readOnly: !!readJson<boolean>("_xReadOnly"),
    isSplit: !!readJson<boolean>("_xIsSplit"),
    canSplit: !!readJson<boolean>("_xCanSplit"),
    isEncrypted: !!readJson<boolean>("_xIsEncrypted"),
    canEncrypt: !!readJson<boolean>("_xCanEncrypt"),
    descCounts: readJson<Record<string, DescCount>>("_xDescCounts") ?? {},
    expanded: readJson<string[]>("_xExpanded") ?? [],
    ui: readJson<Record<string, string>>("_xStrings") ?? {},
  };
}
