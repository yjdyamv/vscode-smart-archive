/**
 * Logger — Smart Archive VSCode Extension
 *
 * Host-side logger built on logger-core, routing structured pino records
 * to the VSCode LogOutputChannel (with level highlighting) and stderr.
 *
 * Usage:
 *   import { logger } from "../utils/logger";
 *   logger.info({ event: "compress.start", format: "7z", files: 3 });
 *   logger.error({ err, event: "decompress.fail", path: inputPath });
 *
 * @module utils/logger
 */

import * as vscode from "vscode";
import { Writable } from "stream";
import { logger as coreLogger, setLoggerSink, levels } from "./logger-core";
import type { LogLevel } from "./logger-core";

let channel: vscode.LogOutputChannel | null = null;

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Smart Archive", { log: true });
  }
  return channel;
}

// Ring buffer of the most recent debug-level records (raw pino lines).
// VS Code's LogOutputChannel filters debug() by its panel level and does
// NOT replay history when the level is raised — so on a switch to Debug we
// re-emit these lines (they route to ch.debug() again and become visible).
const DEBUG_HISTORY_LIMIT = 500;
const debugHistory: string[] = [];
let replayedDebugCount = 0;

/** Re-emit buffered debug lines that the panel level previously hid. */
function replayDebugHistory(): void {
  if (replayedDebugCount > debugHistory.length) replayedDebugCount = 0; // buffer rolled
  for (let i = replayedDebugCount; i < debugHistory.length; i++) {
    channelOut.write(debugHistory[i]);
  }
  replayedDebugCount = debugHistory.length;
}

let logLevelListenerAttached = false;

/** Replay history whenever the user raises the panel level to Debug/Trace. */
function attachLogLevelListener(): void {
  if (logLevelListenerAttached) return;
  logLevelListenerAttached = true;
  const ch = getChannel();
  ch.onDidChangeLogLevel?.((lvl) => {
    if (lvl === vscode.LogLevel.Debug || lvl === vscode.LogLevel.Trace) {
      replayDebugHistory();
    }
  });
}

const channelOut = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void) {
    try {
      const str = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const obj = JSON.parse(str);
      // Keep debug records for replay (workers' forwarded logs pass through
      // here too via writeHostLog, so history covers both sides).
      if (obj.level === levels.debug) {
        debugHistory.push(str);
        if (debugHistory.length > DEBUG_HISTORY_LIMIT) debugHistory.shift();
      }
      const msg = obj.event || obj.msg || "";
      const parts: string[] = [];
      if (obj.err) parts.push(String(obj.err));
      for (const [k, v] of Object.entries(obj)) {
        if (["time", "level", "hostname", "pid", "event", "msg", "err"].includes(k)) continue;
        parts.push(`${k}=${JSON.stringify(v)}`);
      }
      const line = parts.length ? `${msg} ${parts.join(" ")}` : msg;
      const ch = getChannel();
      if (obj.level >= levels.error) ch.error(line);
      else if (obj.level >= levels.warn) ch.warn(line);
      else if (obj.level >= levels.info) ch.info(line);
      else ch.debug(line);
    } catch {
      const text = Buffer.isBuffer(chunk) ? chunk.toString().trim() : String(chunk).trim();
      if (text) getChannel().info(text);
    }
    callback();
  },
});

// Route logger-core records (used by the vscode-free engine modules) to the
// OutputChannel as well, so host-side operations keep their existing logs.
setLoggerSink((chunk) => {
  channelOut.write(chunk);
  process.stderr.write(chunk);
});

/**
 * Write a raw pino JSON line (e.g. forwarded from the archive worker) to
 * the host OutputChannel.
 */
export function writeHostLog(chunk: string): void {
  channelOut.write(chunk);
}

let _lastLevel: LogLevel | null = null;

export const logger = {
  setLevel(lvl: LogLevel): void {
    coreLogger.setLevel(lvl);
    const ch = getChannel();
    attachLogLevelListener();
    // The VS Code LogOutputChannel filters debug() calls by its own panel
    // level (readonly, defaults to env.logLevel = Info). There is no API to
    // force it — but appendLine() is NOT filtered, so when the user asks for
    // debug verbosity we print a one-time hint pointing at the dropdown, and
    // replay any debug lines that were hidden so far.
    if (lvl === "debug" && _lastLevel !== "debug") {
      if (ch.logLevel !== vscode.LogLevel.Debug) {
        ch.appendLine(
          '[Smart Archive] Log level set to debug — switch the output panel dropdown (top right) to "Debug" to see debug lines (earlier lines are replayed on the switch). The choice is remembered per panel.',
        );
      }
    }
    _lastLevel = lvl;
  },

  debug(obj: Record<string, unknown>, msg?: string): void {
    coreLogger.debug(obj, msg);
  },

  info(obj: Record<string, unknown>, msg?: string): void {
    coreLogger.info(obj, msg);
  },

  warn(obj: Record<string, unknown>, msg?: string): void {
    coreLogger.warn(obj, msg);
  },

  error(obj: Record<string, unknown>, msg?: string): void {
    coreLogger.error(obj, msg);
  },

  throw(event: string, err: unknown, data?: Record<string, unknown>): never {
    return coreLogger.throw(event, err, data);
  },

  dispose(): void {
    channel?.dispose();
    channel = null;
  },
};
