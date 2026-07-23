import type { ExtensionMessage } from "../types";

const vscode = acquireVsCodeApi();

export function useMessage() {
  function post(msg: Record<string, unknown>): void {
    vscode.postMessage(msg);
  }

  return { post, onMessage };
}

function onMessage(handler: (msg: ExtensionMessage) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data as ExtensionMessage);
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
