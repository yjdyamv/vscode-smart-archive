import type { TreeNodeData } from "./types";

/**
 * Message protocol between the webview and the extension host.
 *
 * The union is the single source of truth on the webview side: the `post`
 * function in useMessage accepts only these shapes, so a typo'd command name
 * or a wrong payload field fails the build instead of the runtime. The host
 * validates defensively at its seam (router.ts) and sends `HostToWebview`
 * messages, which the webview dispatches in useArchiveView.
 */

/** Webview → host commands. */
export type WebviewToHost =
  | { c: "pw"; pw: string }
  | { c: "extAll" }
  | { c: "extSel"; paths: string[]; excludes?: string[]; flat?: boolean }
  | { c: "copy"; paths: string[]; flat?: boolean }
  | { c: "delSel"; paths: string[] }
  | { c: "addFiles"; dir?: string }
  | { c: "renamePrompt"; path: string }
  | { c: "newFolderPrompt"; dir?: string }
  | { c: "preview"; path: string }
  | { c: "merge" }
  | { c: "split" }
  | { c: "convert" }
  | { c: "encrypt" }
  | { c: "decrypt" }
  | { c: "test" }
  | { c: "expandDir"; path: string }
  | { c: "saveExpanded"; paths: string[] };

/** Host → webview messages. */
export type HostToWebview =
  | { c: "ok"; t: string }
  | { c: "err"; t: string }
  | { c: "pwerr"; t: string }
  | { c: "loading"; t: string | boolean }
  | { c: "dirChildren"; path: string; children: TreeNodeData[] };
