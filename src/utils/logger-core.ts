/**
 * Logger core — Smart Archive VSCode Extension
 *
 * Vscode-free pino logger for worker threads. The host-side logger
 * (utils/logger) re-points the sink to the VSCode LogOutputChannel via
 * setLoggerSink; without a sink, records go to stderr as JSON.
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
    p.debug(sanitize(obj), msg);
  },

  info(obj: Record<string, unknown>, msg?: string): void {
    p.info(sanitize(obj), msg);
  },

  warn(obj: Record<string, unknown>, msg?: string): void {
    p.warn(sanitize(obj), msg);
  },

  error(obj: Record<string, unknown>, msg?: string): void {
    if (obj.err instanceof Error) {
      const e = obj.err;
      obj.err = e.message;
      obj.stack = e.stack?.split("\n").slice(0, 3).join(" | ");
    }
    p.error(sanitize(obj), msg);
  },
};
