/**
 * Webview state — Smart Archive VSCode Extension
 *
 * Shared types and state containers for archive webview instances.
 *
 * @module providers/webview/state
 */

import type * as vscode from "vscode";
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
}

export const handlerStates = new WeakMap<vscode.Webview, HandlerState>();
export const handlerRegistered = new WeakSet<vscode.Webview>();
