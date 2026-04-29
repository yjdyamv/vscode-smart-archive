/**
 * Logger — Smart Archive VSCode Extension
 *
 * Built on pino for structured high-performance logging.
 * Routes to both console (pretty) and VSCode OutputChannel.
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

let channel: vscode.OutputChannel | null = null;
let _level: keyof typeof levels = "info";

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Smart Archive", { log: true });
  }
  return channel;
}

const channelStream = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void) {
    try {
      const str = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const obj = JSON.parse(str);
      const ts = obj.time ? new Date(obj.time).toISOString().slice(11, 23) : "";
      const lvl = (obj.level === 50 ? "ERROR" : obj.level === 40 ? "WARN" : obj.level === 30 ? "INFO" : "DEBUG").padEnd(5);
      let msg = `[${ts}] [${lvl}] ${obj.event || obj.msg || ""}`;
      if (obj.err) msg += ` ${obj.err}`;
      for (const k of Object.keys(obj)) {
        if (k === "time" || k === "level" || k === "hostname" || k === "pid" || k === "event" || k === "msg" || k === "err") continue;
        msg += ` ${k}=${JSON.stringify(obj[k])}`;
      }
      getChannel().appendLine(msg);
    } catch {
      getChannel().appendLine(Buffer.isBuffer(chunk) ? chunk.toString().trim() : String(chunk).trim());
    }
    callback();
  },
});

const p = pino(
  {
    level: _level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: levels[label as keyof typeof levels] ?? 30 };
      },
    },
  },
  pino.multistream([
    { stream: channelStream },
    {
      level: "info",
      stream: pino.transport({ target: "pino/file", options: { destination: 2 } }),
    },
  ]),
);

export const logger = {
  setLevel(lvl: keyof typeof levels): void {
    _level = lvl;
    p.level = lvl;
  },

  debug(obj: Record<string, unknown>, msg?: string): void {
    p.debug(obj, msg);
  },

  info(obj: Record<string, unknown>, msg?: string): void {
    p.info(obj, msg);
  },

  warn(obj: Record<string, unknown>, msg?: string): void {
    p.warn(obj, msg);
  },

  error(obj: Record<string, unknown>, msg?: string): void {
    if (obj.err instanceof Error) {
      const e = obj.err;
      obj.err = e.message;
      obj.stack = e.stack?.split("\n").slice(0, 3).join(" | ");
    }
    p.error(obj, msg);
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
