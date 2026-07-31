/**
 * Logger tests — Smart Archive VSCode Extension
 *
 * Verifies logger.setLevel() semantics on the shared logger-core pino
 * instance, the one-time panel hint emitted when debug verbosity is
 * requested while the panel level is not Debug, and the replay of
 * previously hidden debug records when the panel level is raised
 * (VS Code's LogOutputChannel filters debug() by panel level and does
 * not replay history — the host buffers and re-emits it).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { Writable } from "stream";
import { setLoggerSink } from "../src/utils/logger-core";
import { logger } from "../src/utils/logger";

const flush = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  logger.setLevel("info");
});

/**
 * A LogOutputChannel double that mimics the real filtering: level methods
 * only record when the panel logLevel allows them; appendLine never
 * filters; setting logLevel fires onDidChangeLogLevel.
 */
function makeChannel(initialLevel: number = vscode.LogLevel.Info) {
  const listeners: Array<(lvl: number) => void> = [];
  let logLevel = initialLevel;
  const calls: Record<"debug" | "info" | "warn" | "error", string[]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const record = (bucket: keyof typeof calls, threshold: number) => (line: string) => {
    if (logLevel <= threshold) calls[bucket].push(line);
  };
  const channel = {
    get logLevel() {
      return logLevel;
    },
    set logLevel(lvl: number) {
      logLevel = lvl;
      for (const cb of listeners) cb(lvl);
    },
    appendLine: vi.fn(),
    onDidChangeLogLevel: vi.fn((cb: (lvl: number) => void) => {
      listeners.push(cb);
      return { dispose: vi.fn() };
    }),
    info: vi.fn(record("info", vscode.LogLevel.Info)),
    warn: vi.fn(record("warn", vscode.LogLevel.Warning)),
    error: vi.fn(record("error", vscode.LogLevel.Error)),
    debug: vi.fn(record("debug", vscode.LogLevel.Debug)),
    show: vi.fn(),
    dispose: vi.fn(),
  };
  return { channel, calls, listeners };
}

async function freshLoggerAndChannel(initialLevel?: number) {
  vi.resetModules();
  const { logger: freshLogger } = await import("../src/utils/logger");
  const vs = await import("vscode");
  const { channel, calls, listeners } = makeChannel(initialLevel);
  const spy = vi
    .spyOn(vs.window, "createOutputChannel")
    .mockReturnValue(channel as unknown as vscode.LogOutputChannel);
  return { freshLogger, channel, calls, listeners, spy };
}

describe("logger.setLevel", () => {
  it("routes debug records through the shared pino after setLevel('debug')", async () => {
    const received: string[] = [];
    const sink = new Writable({
      write(chunk: unknown, _enc: string, cb: () => void) {
        received.push(String(chunk));
        cb();
      },
    });
    setLoggerSink((chunk) => sink.write(chunk));
    try {
      logger.setLevel("debug");
      logger.debug({ event: "lvl.debug" }, "x");
      await flush();
      expect(received.some((l) => l.includes("lvl.debug"))).toBe(true);
    } finally {
      setLoggerSink(undefined);
    }
  });

  it("drops debug records at info level", async () => {
    const received: string[] = [];
    const sink = new Writable({
      write(chunk: unknown, _enc: string, cb: () => void) {
        received.push(String(chunk));
        cb();
      },
    });
    setLoggerSink((chunk) => sink.write(chunk));
    try {
      logger.setLevel("info");
      logger.debug({ event: "lvl.hidden" }, "x");
      await flush();
      expect(received.some((l) => l.includes("lvl.hidden"))).toBe(false);
    } finally {
      setLoggerSink(undefined);
    }
  });

  it("emits the panel hint exactly once when switching to debug", async () => {
    const { freshLogger, channel, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.setLevel("debug");
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
      expect(channel.appendLine.mock.calls[0][0]).toContain("dropdown");

      // Switching to another level and back re-arms the hint.
      freshLogger.setLevel("info");
      freshLogger.setLevel("debug");
      expect(channel.appendLine).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("skips the hint when the panel level is already Debug", async () => {
    const { freshLogger, channel, spy } = await freshLoggerAndChannel(vscode.LogLevel.Debug);
    try {
      freshLogger.setLevel("debug");
      expect(channel.appendLine).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("replays previously hidden debug records when the panel level is raised", async () => {
    const { freshLogger, channel, calls, listeners, spy } = await freshLoggerAndChannel();
    try {
      // logLevel=debug: pino lets debug records through, but the Info panel
      // level hides them — they are buffered for replay.
      freshLogger.setLevel("debug");
      freshLogger.debug({ event: "replay.one" });
      freshLogger.debug({ event: "replay.two" });
      await flush();
      expect(calls.debug).toHaveLength(0);

      // Simulate the user picking "Debug" in the panel dropdown.
      channel.logLevel = vscode.LogLevel.Debug;
      for (const cb of listeners) cb(vscode.LogLevel.Debug);
      await flush();
      expect(calls.debug).toEqual(
        expect.arrayContaining([
          expect.stringContaining("replay.one"),
          expect.stringContaining("replay.two"),
        ]),
      );

      // Raising the level again must not duplicate already-replayed records.
      const callsAfterReplay = calls.debug.length;
      channel.logLevel = vscode.LogLevel.Info;
      for (const cb of listeners) cb(vscode.LogLevel.Info);
      channel.logLevel = vscode.LogLevel.Debug;
      for (const cb of listeners) cb(vscode.LogLevel.Debug);
      await flush();
      expect(calls.debug.length).toBe(callsAfterReplay);

      // New records after the switch appear live (and are not replayed twice).
      freshLogger.debug({ event: "replay.live" });
      await flush();
      expect(calls.debug).toEqual(
        expect.arrayContaining([expect.stringContaining("replay.live")]),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("replays history when the panel level changes to Debug", async () => {
    const { freshLogger, channel, calls, listeners, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.setLevel("debug");
      freshLogger.debug({ event: "replay.panel" });
      await flush();
      expect(calls.debug).toHaveLength(0);

      // Simulate the user picking "Debug" in the panel dropdown.
      channel.logLevel = vscode.LogLevel.Debug;
      for (const cb of listeners) cb(vscode.LogLevel.Debug);
      await flush();
      expect(calls.debug).toEqual(
        expect.arrayContaining([expect.stringContaining("replay.panel")]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
