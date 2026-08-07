import type { WebviewToHost, HostToWebview } from "../protocol";

const vscode = acquireVsCodeApi();

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
