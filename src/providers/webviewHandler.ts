/**
 * Webview handler — barrel re-export for archive webview modules.
 *
 * @module providers/webviewHandler
 */

export { setupWebview } from "./webview/setup";
export { registerHandler } from "./webview/router";
export { handlerStates, handlerRegistered } from "./webview/state";
export type { HandlerState } from "./webview/state";
