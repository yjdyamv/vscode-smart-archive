/**
 * Logger — Smart Archive VSCode Extension
 *
 * Built on pino for structured high-performance logging.
 * Routes to VSCode LogOutputChannel (with level highlighting)
 * and stderr (JSON for programmatic use).
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
import pino from "pino";

const levels = { debug: 20, info: 30, warn: 40, error: 50 } as const;

let channel: vscode.LogOutputChannel | null = null;
let _level: keyof typeof levels = "info";

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Smart Archive", { log: true });
  }
  return channel;
}

const channelOut = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void) {
    try {
      const str = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const obj = JSON.parse(str);
      const msg = obj.event || obj.msg || "";
      const parts: string[] = [];
      if (obj.err) parts.push(String(obj.err));
      for (const [k, v] of Object.entries(obj)) {
        if (["time", "level", "hostname", "pid", "event", "msg", "err"].includes(k)) continue;
        parts.push(`${k}=${JSON.stringify(v)}`);
      }
      const line = parts.length ? `${msg} ${parts.join(" ")}` : msg;
      const ch = getChannel();
      if (obj.level >= 50) ch.error(line);
      else if (obj.level >= 40) ch.warn(line);
      else if (obj.level >= 30) ch.info(line);
      else ch.debug(line);
    } catch {
      const text = Buffer.isBuffer(chunk) ? chunk.toString().trim() : String(chunk).trim();
      if (text) getChannel().info(text);
    }
    callback();
  },
});

/** Sanitize sensitive fields before hitting any output */
function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
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
    level: _level,
    messageKey: "event",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: levels[label as keyof typeof levels] ?? 30 };
      },
    },
  },
  pino.multistream([{ stream: channelOut }, { level: "info", stream: process.stderr }]),
);

export const logger = {
  setLevel(lvl: keyof typeof levels): void {
    _level = lvl;
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

  throw(event: string, err: unknown, data?: Record<string, unknown>): never {
    logger.error({ event, err, ...data });
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  },

  dispose(): void {
    channel?.dispose();
    channel = null;
  },
};
