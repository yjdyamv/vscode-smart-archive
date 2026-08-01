/**
 * Logger — Smart Archive VSCode Extension
 *
 * Host-side logger built on logger-core, routing structured pino records
 * to the "Smart Archive" output panel and stderr.
 *
 * Rendering model: a plain OutputChannel with appendLine for every record,
 * formatted with a level tag and timestamp. This is deliberate — VS Code's
 * LogOutputChannel filters level methods by its own panel level at append
 * time and its clear() is a no-op in the extension host, so its content
 * can never be rebuilt or pruned. With a plain channel we own the whole
 * buffer: every record is appended unfiltered, and a log-level change
 * (the smart-archive.logLevel setting) clears the panel and re-renders it
 * from the history buffer in sequence order. Lowering the level removes
 * the now-excluded lines; raising it brings buffered records back.
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
import { DEFAULT_LOG_HISTORY_BYTES } from "../constants";

let channel: vscode.OutputChannel | null = null;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Smart Archive");
  }
  return channel;
}

// Byte-budgeted buffer of structured log records (all levels). Records are
// re-rendered from here when the log level changes; worker-forwarded logs
// pass through channelOut too, so history covers both sides of the extension.
const logHistory = new LogHistory(DEFAULT_LOG_HISTORY_BYTES);

/** Resize the history byte budget (from the logHistoryBytes setting). */
export function setHistoryBudget(bytes: number): void {
  logHistory.setMaxBytes(bytes);
}

/**
 * Current production log level (the logLevel setting, mirrored from pino).
 * `null` after module init or dispose — a level change event (or the first
 * setLevel of a session) then rebuilds the panel unconditionally, purging
 * stale content the output panel may have restored across a window reload.
 */
let currentLevel: LogLevel | null = null;

function levelName(level: unknown): string {
  if (level === levels.error) return "error";
  if (level === levels.warn) return "warn";
  if (level === levels.info) return "info";
  return "debug";
}

/** Format a pino ISO timestamp as "YYYY-MM-DD HH:MM:SS.mmm" (local time). */
function formatTime(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Format one raw pino JSON record into the panel line:
 * "time [level] event key=value". Mirrors the native log-panel look.
 */
function formatLine(obj: Record<string, unknown>): string {
  const msg = obj.event || obj.msg || "";
  const parts: string[] = [];
  if (obj.err) parts.push(String(obj.err));
  for (const [k, v] of Object.entries(obj)) {
    if (["time", "level", "hostname", "pid", "event", "msg", "err"].includes(k)) continue;
    parts.push(`${k}=${JSON.stringify(v)}`);
  }
  const body = parts.length ? `${msg} ${parts.join(" ")}` : msg;
  const tag = `[${levelName(obj.level)}]`;
  const line = body ? `${tag} ${body}` : tag;
  const ts = formatTime(obj.time);
  return ts ? `${ts} ${line}` : line;
}

/** Append a non-JSON line verbatim (trimmed), if non-empty. */
function appendRaw(ch: vscode.OutputChannel, text: string): void {
  const trimmed = text.trim();
  if (trimmed) ch.appendLine(trimmed);
}

/** Rebuild the whole panel content from history at the current level. */
function rebuildPanel(): void {
  const ch = getChannel();
  ch.clear();
  const minLevel = levels[currentLevel ?? "info"];
  logHistory.replayAll(minLevel, (raw) => {
    try {
      ch.appendLine(formatLine(JSON.parse(raw) as Record<string, unknown>));
    } catch {
      appendRaw(ch, raw);
    }
  });
}

const channelOut = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void) {
    try {
      const str = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const obj = JSON.parse(str) as Record<string, unknown>;
      const level = typeof obj.level === "number" ? obj.level : 0;
      // Buffer every structured record for re-rendering on level changes
      // (bounded by bytes).
      logHistory.push(level, str);
      getChannel().appendLine(formatLine(obj));
    } catch {
      appendRaw(getChannel(), Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    }
    callback();
  },
});

// Route logger-core records (used by the vscode-free engine modules) to the
// output panel as well, so host-side operations keep their existing logs.
setLoggerSink((chunk) => {
  channelOut.write(chunk);
  process.stderr.write(chunk);
});

/**
 * Write a raw pino JSON line (e.g. forwarded from the archive worker) to
 * the host output panel.
 */
export function writeHostLog(chunk: string): void {
  channelOut.write(chunk);
}

export const logger = {
  setLevel(lvl: LogLevel): void {
    coreLogger.setLevel(lvl);
    if (lvl === currentLevel) return;
    currentLevel = lvl;
    // Re-render the panel at the new level: raising reveals buffered
    // records, lowering removes the now-excluded lines.
    rebuildPanel();
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
    // Reset state so a re-activation (same process) starts with a fresh
    // level and history; the next setLevel rebuilds the panel and purges
    // stale content restored by the output panel.
    currentLevel = null;
    logHistory.reset();
    channel?.dispose();
    channel = null;
  },
};
