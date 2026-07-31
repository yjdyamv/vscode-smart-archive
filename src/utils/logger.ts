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
import { LogHistory } from "./log-history";

let channel: vscode.LogOutputChannel | null = null;

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Smart Archive", { log: true });
  }
  return channel;
}

// Byte-budgeted buffer of structured log records (all levels). VS Code's
// LogOutputChannel filters level methods by its own panel level and does
// NOT replay history when the level is raised — on a panel-level change we
// re-emit the lines the previous level hid, filtered by the new level.
// Worker-forwarded logs pass through channelOut too, so history covers both
// sides of the extension.
const logHistory = new LogHistory();

let logLevelListenerAttached = false;
let envLevelListenerAttached = false;

// Verbosity ordering of VS Code LogLevel, independent of the enum's numeric
// values (which differ between @types/vscode and the running extension host):
// Off(0) < Error(1) < Warning(2) < Info(3) < Debug(4) < Trace(5).
function panelVerbosity(lvl: vscode.LogLevel): number {
  switch (lvl) {
    case vscode.LogLevel.Off:
      return 0;
    case vscode.LogLevel.Error:
      return 1;
    case vscode.LogLevel.Warning:
      return 2;
    case vscode.LogLevel.Info:
      return 3;
    case vscode.LogLevel.Debug:
      return 4;
    default:
      return 5; // Trace
  }
}

/** Map a VS Code LogLevel to the minimum pino level a replay must include. */
function minPinoLevelForPanel(lvl: vscode.LogLevel): number {
  switch (panelVerbosity(lvl)) {
    case 0:
      return Number.MAX_SAFE_INTEGER; // Off — nothing visible
    case 1:
      return levels.error;
    case 2:
      return levels.warn;
    case 3:
      return levels.info;
    default: // Debug / Trace — we have no trace records; debug is the floor
      return levels.debug;
  }
}

/** Map a pino level to its verbosity ordering (mirror of panelVerbosity). */
function pinoVerbosity(level: number): number {
  if (level >= levels.error) return 1;
  if (level >= levels.warn) return 2;
  if (level >= levels.info) return 3;
  return 4; // debug
}

/**
 * Whether a record with `pinoLevel` is shown by a panel at `panelLogLevel`.
 * VS Code semantics: a panel shows records at least as detailed as its own
 * level (Warning panel → warning+error; Debug panel → debug+info+…).
 */
function isVisibleAtPanelLevel(pinoLevel: number, panelLogLevel: vscode.LogLevel): boolean {
  return pinoVerbosity(pinoLevel) <= panelVerbosity(panelLogLevel);
}

/** Re-emit buffered records that the given panel level now allows. */
function replayHistoryForPanelLevel(lvl: vscode.LogLevel): void {
  if (lvl === vscode.LogLevel.Off) return;
  const minLevel = minPinoLevelForPanel(lvl);
  // Replay is idempotent per cursor; concurrent pushes after the snapshot
  // are delivered live by the regular routing and never replayed.
  logHistory.replayFrom(replayedCursor, minLevel, (line) => channelOut.write(line));
  replayedCursor = logHistory.cursor;
}

let replayedCursor = 0;

/** Replay history when the panel level changes (dropdown or env-driven). */
function attachLogLevelListeners(): void {
  const ch = getChannel();
  if (!logLevelListenerAttached) {
    logLevelListenerAttached = true;
    ch.onDidChangeLogLevel?.((lvl) => replayHistoryForPanelLevel(lvl));
  }
  // env.logLevel drives the panel default; a global change (--log /
  // setLogLevel command) may re-level the channel without its own event.
  if (!envLevelListenerAttached) {
    envLevelListenerAttached = true;
    vscode.env.onDidChangeLogLevel?.((lvl) => replayHistoryForPanelLevel(lvl));
  }
}

const channelOut = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void) {
    try {
      const str = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const obj = JSON.parse(str);
      const level = typeof obj.level === "number" ? obj.level : 0;
      // Buffer every structured record for future replay (bounded by bytes).
      // Records the panel already shows are marked visible so a later
      // replay never duplicates them.
      logHistory.push(level, str, isVisibleAtPanelLevel(level, getChannel().logLevel));
      const msg = obj.event || obj.msg || "";
      const parts: string[] = [];
      if (obj.err) parts.push(String(obj.err));
      for (const [k, v] of Object.entries(obj)) {
        if (["time", "level", "hostname", "pid", "event", "msg", "err"].includes(k)) continue;
        parts.push(`${k}=${JSON.stringify(v)}`);
      }
      const line = parts.length ? `${msg} ${parts.join(" ")}` : msg;
      const ch = getChannel();
      if (level >= levels.error) ch.error(line);
      else if (level >= levels.warn) ch.warn(line);
      else if (level >= levels.info) ch.info(line);
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
    attachLogLevelListeners();
    // The VS Code LogOutputChannel filters level methods by its own panel
    // level (readonly, defaults to env.logLevel = Info). There is no API to
    // force it — but appendLine() is NOT filtered, so when the user asks for
    // debug verbosity we print a one-time hint pointing at the dropdown.
    // (History is replayed automatically on the panel-level switch.)
    if (lvl === "debug" && _lastLevel !== "debug") {
      if (ch.logLevel !== vscode.LogLevel.Debug) {
        ch.appendLine(
          '[Smart Archive] Log level set to debug — switch the output panel dropdown (top right) to "Debug" to see debug lines; earlier lines are replayed automatically on the switch. The choice is remembered per panel.',
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
    // Reset listeners/cursor so a re-activation (same process) rebuilds a
    // fresh channel with working replay.
    logLevelListenerAttached = false;
    envLevelListenerAttached = false;
    replayedCursor = 0;
    logHistory.reset();
    channel?.dispose();
    channel = null;
  },
};
