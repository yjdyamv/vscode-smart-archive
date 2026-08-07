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

// Upper bound on a message's `paths` array. The archive listing itself is
// capped at 100k entries (parse7z MAX_ENTRIES), so a legitimate "select all"
// cannot exceed that; this leaves headroom while bounding a malformed webview.
const MAX_MSG_PATHS = 200_000;

// Per-message debug logging for high-frequency messages (expandDir fires per
// folder expansion, saveExpanded per expansion toggle — opening an archive
// with many restored expanded paths bursts dozens at once). Burst
// aggregation: the first message of each type logs immediately, further
// ones within a quiet window are counted, and one "×N" summary line per
// type is emitted when the window closes — signal without the screen-flood.
const BURST_WINDOW_MS = 1000;

interface BurstLogger {
  log: (c: string, dir: string | undefined) => void;
  dispose: () => void;
}

/** Create a per-webview burst aggregator (state never crosses webviews). */
function createBurstLogger(): BurstLogger {
  const totals = new Map<string, number>();
  const firstDir = new Map<string, string | undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let self: BurstLogger;

  const flush = (): void => {
    timer = undefined;
    activeBurstLoggers.delete(self);
    for (const [c, total] of totals) {
      if (total > 1) {
        logger.debug({ event: "webview.msg.burst", c, total });
      }
    }
    totals.clear();
    firstDir.clear();
  };

  const log = (c: string, dir: string | undefined): void => {
    const total = (totals.get(c) ?? 0) + 1;
    totals.set(c, total);
    if (total === 1) {
      firstDir.set(c, dir);
      logger.debug({ event: "webview.msg", c, dir });
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, BURST_WINDOW_MS);
  };

  const dispose = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    activeBurstLoggers.delete(self);
    totals.clear();
    firstDir.clear();
  };

  self = { log, dispose };
  activeBurstLoggers.add(self);
  return self;
}

const activeBurstLoggers = new Set<BurstLogger>();

/** Drop pending burst timers (called on extension deactivation). */
export function disposeBurstLoggers(): void {
  for (const b of activeBurstLoggers) b.dispose();
  activeBurstLoggers.clear();
}

/**
 * Reject structurally malformed webview → extension messages before they reach
 * a handler. Defense-in-depth: with the CSP in place the webview is not
 * attacker-controlled, but a buggy or crafted message must not drive
 * filesystem/spawn operations with the wrong types or an unbounded array.
 */
function isValidMsg(msg: WebviewMsg): boolean {
  const m = msg as unknown as Record<string, unknown>;
  for (const k of ["path", "dir", "pw", "msg"]) {
    if (m[k] !== undefined && typeof m[k] !== "string") return false;
  }
  if (m.paths !== undefined) {
    if (!Array.isArray(m.paths) || m.paths.length > MAX_MSG_PATHS) return false;
    for (const p of m.paths) {
      if (typeof p !== "string") return false;
    }
  }
  return true;
}

/**
 * Register the webview message handler for an archive viewer instance.
 * Uses a command → handler map rather than a switch-case for extensibility.
 */
export function registerHandler(webview: vscode.Webview): void {
  const burstLog = createBurstLogger();
  webview.onDidReceiveMessage((msg: WebviewMsg) => {
    (async () => {
      if (msg.c === "expandDir" || msg.c === "saveExpanded") {
        burstLog.log(msg.c, msg.dir);
      } else {
        logger.info({ event: "webview.msg", c: msg.c, dir: msg.dir });
      }
      const s = handlerStates.get(webview);
      if (!s) return;

      if (!isValidMsg(msg)) {
        logger.warn(
          { event: "webview.msg.invalid", c: msg.c },
          "Rejected malformed webview message",
        );
        return;
      }

      // Lightweight inline handlers
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
