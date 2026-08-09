/**
 * Logger core — Smart Archive VSCode Extension
 *
 * Vscode-free pino logger for worker threads. The host-side logger
 * (utils/logger) re-points the sink to the VSCode LogOutputChannel via
 * setLoggerSink; without a sink, records go to stderr as JSON.
 *
 * ── Log event naming ──────────────────────────────────────────────
 * Every structured record uses `event: "<namespace>.<action>[.<result>]"`.
 *
 *   namespace — the module name that emits the event (system7z, webview,
 *               addToArchive, copyPaste, …). Dotted, lowercase first
 *               segment; compound module names keep their camelCase.
 *   result    — one of the fixed vocabulary:
 *               start / done / ok / failed / cancelled / skip / warn
 *               (start/done = lifecycle begin/end, ok/failed = outcome,
 *                cancelled/skip/warn = special outcomes).
 *   Forbidden as a final segment: error, complete, success, enter, exit.
 *
 * Enforced by test/event-naming.test.ts — keep new events in this shape.
 *
 * @module utils/logger-core
 */

import { Writable } from "stream";
import pino from "pino";

export const levels = { debug: 20, info: 30, warn: 40, error: 50 } as const;

export type LogLevel = keyof typeof levels;

let sinkFn: ((chunk: Buffer | string) => void) | undefined;

/** Redirect all records to a custom sink (host OutputChannel). */
export function setLoggerSink(fn: ((chunk: Buffer | string) => void) | undefined): void {
  sinkFn = fn;
}

const sink = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void) {
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (sinkFn) sinkFn(data);
      else process.stderr.write(data);
    } catch {
      try {
        process.stderr.write(Buffer.from(String(chunk)));
      } catch {
        // last resort — never let logging break the pipeline
      }
    }
    callback();
  },
});

/** Sanitize sensitive fields before hitting any output */
export function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "password" || k === "pw" || k === "pass") {
      out[k] = "***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Normalize an `err` field before pino serializes it. pino's default
 * serializer turns Error instances into plain objects ({type,message,stack})
 * and non-Error throws (e.g. emscripten ErrnoError) may be objects too —
 * the output panel's String(obj.err) would render either as
 * "[object Object]" and hide the failure. Errors become the message plus a
 * short stack; other objects keep their name/errno/message parts joined.
 */
function errField(err: unknown): Record<string, unknown> {
  if (err == null) return { err };
  if (err instanceof Error) {
    return { err: err.message, stack: err.stack?.split("\n").slice(0, 3).join(" | ") };
  }
  if (typeof err === "object") {
    const e = err as { name?: unknown; errno?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof e.name === "string" && e.name) parts.push(e.name);
    if (typeof e.errno === "number") parts.push(`errno=${e.errno}`);
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (parts.length > 0) return { err: parts.join(": ") };
  }
  return { err: String(err) };
}

/** Apply the err-field normalization to a record that carries one. */
function normalizeErr(obj: Record<string, unknown>): Record<string, unknown> {
  if (!("err" in obj)) return obj;
  return { ...obj, ...errField(obj.err) };
}

const p = pino(
  {
    level: "info",
    messageKey: "event",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: levels[label as LogLevel] ?? 30 };
      },
    },
  },
  sink,
);

export const logger = {
  setLevel(lvl: LogLevel): void {
    p.level = lvl;
  },

  debug(obj: Record<string, unknown>, msg?: string): void {
    p.debug(sanitize(normalizeErr(obj)), msg);
  },

  info(obj: Record<string, unknown>, msg?: string): void {
    p.info(sanitize(normalizeErr(obj)), msg);
  },

  warn(obj: Record<string, unknown>, msg?: string): void {
    p.warn(sanitize(normalizeErr(obj)), msg);
  },

  error(obj: Record<string, unknown>, msg?: string): void {
    p.error(sanitize(normalizeErr(obj)), msg);
  },
};
