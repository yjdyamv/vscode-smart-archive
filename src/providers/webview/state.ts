/**
 * Webview state — Smart Archive VSCode Extension
 *
 * Shared types and state containers for archive webview instances.
 *
 * @module providers/webview/state
 */

import * as vscode from "vscode";
import type { FlatEntry, EntryIndex } from "../treeBuilder";

export const EXT_ID = "yjdyamv.smart-archive";

export interface HandlerState {
  archiveUri: vscode.Uri;
  archiveName: string;
  filePath: string;
  password: string | undefined;
  entries: FlatEntry[];
  entryIndex: EntryIndex;
  isEncrypted: boolean;
  /** Cancellation source for the current long-running operation */
  cancelSource: vscode.CancellationTokenSource | null;
}

export const handlerStates = new WeakMap<vscode.Webview, HandlerState>();
export const handlerRegistered = new WeakSet<vscode.Webview>();

/**
 * Create a fresh cancellation source for a new operation,
 * cancelling any previous pending operation on this webview.
 */
export function startOperation(state: HandlerState): vscode.CancellationToken {
  state.cancelSource?.cancel();
  state.cancelSource = new vscode.CancellationTokenSource();
  return state.cancelSource.token;
}

/** Clean up the cancellation source after operation completes. */
export function endOperation(state: HandlerState): void {
  if (state.cancelSource) {
    state.cancelSource.dispose();
    state.cancelSource = null;
  }
}
