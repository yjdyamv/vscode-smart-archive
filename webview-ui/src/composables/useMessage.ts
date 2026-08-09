import type { WebviewToHost, HostToWebview } from "../protocol";

/**
 * VS Code host API. In the browser (vite dev preview) acquireVsCodeApi does
 * not exist — fall back to a no-op bridge: posts go to the console and are
 * re-dispatched as a `webview-to-host` CustomEvent (the dev mock host
 * listens), state persists in localStorage.
 */
const vscode =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : createBrowserFallback();

function createBrowserFallback(): ReturnType<typeof acquireVsCodeApi> {
  const cached = localStorage.getItem("sa-webview-state");
  const state: unknown = cached ? (JSON.parse(cached) as unknown) : undefined;
  return {
    postMessage(msg: WebviewToHost): void {
      console.info("[webview → host]", msg);
      window.dispatchEvent(new CustomEvent("webview-to-host", { detail: msg }));
    },
    getState() {
      return state;
    },
    setState(next: unknown): void {
      localStorage.setItem("sa-webview-state", JSON.stringify(next));
    },
  };
}

export function useMessage() {
  function post(msg: WebviewToHost): void {
    vscode.postMessage(msg);
  }

  return { post, onMessage };
}

function onMessage(handler: (msg: HostToWebview) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data as HostToWebview);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export function saveState(state: unknown): void {
  const prev = vscode.getState() as Record<string, unknown> | undefined;
  vscode.setState({ ...prev, ...(state as Record<string, unknown>) });
}

export function loadState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}
