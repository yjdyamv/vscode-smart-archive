/**
 * Persistent expanded state — Smart Archive VSCode Extension
 *
 * Saves expanded directory paths to extension globalState so they survive
 * closing and reopening an archive. Cleared on extension deactivation.
 *
 * @module providers/webview/expandedState
 */

import * as vscode from "vscode";

let _globalState: vscode.Memento | null = null;

export function setGlobalState(state: vscode.Memento): void {
  _globalState = state;
}

export function saveExpandedPaths(archiveUri: vscode.Uri, paths: string[]): void {
  _globalState?.update(`expanded:${archiveUri.toString()}`, paths);
}

export function loadExpandedPaths(archiveUri: vscode.Uri): string[] {
  return _globalState?.get<string[]>(`expanded:${archiveUri.toString()}`) ?? [];
}
