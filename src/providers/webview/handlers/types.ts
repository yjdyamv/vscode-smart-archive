/**
 * Shared types for webview message handlers.
 *
 * @module providers/webview/handlers/types
 */

import * as vscode from "vscode";
import type { HandlerState } from "../state";

export interface WebviewMsg {
  c: string;
  paths?: string[];
  msg?: string;
  flat?: boolean;
  excludes?: string[];
  path?: string;
  dir?: string;
  name?: string;
  pw?: string;
}

export interface HandlerContext {
  webview: vscode.Webview;
  state: HandlerState;
  msg: WebviewMsg;
}

export type MessageHandler = (ctx: HandlerContext) => Promise<void>;
