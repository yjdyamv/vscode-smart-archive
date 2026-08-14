import type { Ref } from "vue";
import type { HostToWebview } from "../protocol";
import type { SelectionController } from "./useSelection";
import type { TreeController } from "./useTree";

export interface MessageDispatcherContext {
  onMessage: (handler: (msg: HostToWebview) => void) => () => void;
  tree: TreeController;
  selection: SelectionController;
  showToast: (msg: string, ok?: boolean) => void;
  viewState: Ref<string>;
  loadingMsg: Ref<string>;
  pwError: Ref<boolean>;
  loadExpandedPaths: () => void;
  /**
   * Set while a Ctrl+A select-all is draining its lazy loads: every
   * directory inserted in this window extends the selection, so unloaded
   * descendants are included once their children arrive.
   */
  selectAllPending: Ref<boolean>;
}

/**
 * Host → webview message routing. The single seam through which every
 * postMessage reply enters the archive view.
 */
export function createMessageDispatcher(ctx: MessageDispatcherContext) {
  function handleMessage(msg: HostToWebview) {
    switch (msg.c) {
      case "ok":
        ctx.showToast(msg.t, true);
        ctx.viewState.value = "content";
        break;
      case "err":
        ctx.showToast(msg.t, false);
        ctx.viewState.value = "content";
        break;
      case "loading":
        if (typeof msg.t === "string") {
          ctx.loadingMsg.value = msg.t;
          ctx.viewState.value = "loading";
        } else {
          ctx.viewState.value = msg.t ? "loading" : "content";
        }
        break;
      case "pwerr":
        ctx.pwError.value = true;
        break;
      case "dirChildren": {
        const parentPath = msg.path;
        const children = msg.children;
        if (parentPath && Array.isArray(children)) {
          const childPaths = ctx.tree.insertChildren(parentPath, children);
          for (const c of children) {
            if (c.kind === "DIRECTORY" && (c.hasMore || (c.children?.length ?? 0) > 0)) {
              if (!c.collapsed && ctx.tree.shouldAutoExpandChild(c.path)) {
                ctx.tree.expandedPaths.value.add(c.path);
              }
            }
          }
          if (ctx.selection.state.selected.has(parentPath)) {
            for (const childPath of childPaths) ctx.selection.state.selected.add(childPath);
          }
          if (ctx.selectAllPending.value) {
            for (const childPath of childPaths) ctx.selection.state.selected.add(childPath);
          }
          ctx.loadExpandedPaths();
        }
        break;
      }
    }
  }

  function setup(): () => void {
    return ctx.onMessage(handleMessage);
  }

  return { setup, handleMessage };
}
