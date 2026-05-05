const vscode = acquireVsCodeApi();

export function useMessage() {
  function post(msg: Record<string, unknown>): void {
    vscode.postMessage(msg);
  }

  function onMessage(handler: (msg: Record<string, unknown>) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data as Record<string, unknown>);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }

  return { post, onMessage };
}

export function saveState(state: unknown): void {
  const prev = vscode.getState() as Record<string, unknown> | undefined;
  vscode.setState({ ...prev, ...(state as Record<string, unknown>) });
}

export function loadState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}
