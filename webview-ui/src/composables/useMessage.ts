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

  function saveState(state: unknown): void {
    vscode.setState(state);
  }

  function loadState<T>(): T | undefined {
    return vscode.getState() as T | undefined;
  }

  return { post, onMessage, saveState, loadState };
}
