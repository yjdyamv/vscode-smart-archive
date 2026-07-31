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

export const logger = {
  setLevel(lvl: LogLevel): void {
    coreLogger.setLevel(lvl);
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
