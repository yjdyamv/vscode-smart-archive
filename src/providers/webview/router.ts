/**
 * Webview message router — Smart Archive VSCode Extension
 *
 * Dispatches webview → extension messages using a command-string `c` field.
 * Each command maps to a handler function via a lookup table.
 *
 * ── Message protocol ──────────────────────────────────────────────────
 *
 * Extension → Webview (postMessage):
 *   { c: "ok",        t: string }                     success notification
 *   { c: "err",       t: string }                     error notification
 *   { c: "pwerr",     t: string }                     wrong-password feedback
 *   { c: "loading",   t: string | false }             loading overlay
 *   { c: "dirChildren", path: string, children }      lazy directory expansion
 *   { c: "encState",  v: boolean }                    encryption state change
 *
 * Webview → Extension (`c` field):
 *   pw            { c: "pw",            pw: string }
 *   extAll        { c: "extAll" }
 *   extSel        { c: "extSel",        paths: string[], flat?, excludes? }
 *   copy          { c: "copy",          paths: string[], flat? }
 *   delSel        { c: "delSel",        paths: string[] }
 *   renamePrompt  { c: "renamePrompt",  path: string }
 *   addFiles      { c: "addFiles",      dir?: string }
 *   dropFiles     { c: "dropFiles",     paths: string[], dir? }
 *   newFolderPrompt { c: "newFolderPrompt", dir?: string }
 *   preview       { c: "preview",       path: string }
 *   merge         { c: "merge" }
 *   split         { c: "split" }
 *   convert       { c: "convert" }
 *   encrypt       { c: "encrypt" }
 *   decrypt       { c: "decrypt" }
 *   test          { c: "test" }
 *   expandDir     { c: "expandDir",     path: string }
 *   saveExpanded  { c: "saveExpanded",  paths: string[] }
 *   log           { c: "log",           msg: string }
 *
 * @module providers/webview/router
 */

import * as vscode from "vscode";
import { logger } from "../../utils/logger";
import { handlerStates } from "./state";
import { getDirChildren, markNoisyDirs } from "../treeBuilder";
import { getNoisyPatterns } from "./helpers";
import { saveExpandedPaths } from "./expandedState";
import { HANDLERS } from "./handlers";
import type { WebviewMsg } from "./handlers/types";

// Re-export shared utilities for backward compatibility with tests
export { getSplitVolumeStem, getSplitOutputPath, detectVolumeSize } from "./handlers/shared";

/**
 * Register the webview message handler for an archive viewer instance.
 * Uses a command → handler map rather than a switch-case for extensibility.
 */
export function registerHandler(webview: vscode.Webview): void {
  webview.onDidReceiveMessage((msg: WebviewMsg) => {
    (async () => {
      if (msg.c === "expandDir" || msg.c === "saveExpanded") {
        logger.debug({ event: "webview.msg", c: msg.c, dir: msg.dir });
      } else {
        logger.info({ event: "webview.msg", c: msg.c, dir: msg.dir });
      }
      const s = handlerStates.get(webview);
      if (!s) return;

      // Lightweight inline handlers
      if (msg.c === "log") {
        logger.debug({ event: "webview.ui", msg: msg.msg });
        return;
      }

      if (msg.c === "expandDir" && typeof msg.path === "string") {
        const children = getDirChildren(msg.path, s.entries, s.entryIndex);
        markNoisyDirs(children, getNoisyPatterns());
        webview.postMessage({ c: "dirChildren", path: msg.path, children });
        return;
      }

      if (msg.c === "saveExpanded" && Array.isArray(msg.paths)) {
        await saveExpandedPaths(s.archiveUri, msg.paths, s.isEncrypted);
        return;
      }

      // Map-based dispatch for command handlers
      const handler = HANDLERS[msg.c];
      if (handler) {
        await handler({ webview, state: s, msg });
      }
    })().catch((err) => {
      logger.error({ event: "webview.msg.unhandled", err }, "Unhandled webview message error");
      try {
        webview.postMessage({
          c: "err",
          t: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // webview may already be disposed
      }
    });
  });
}
