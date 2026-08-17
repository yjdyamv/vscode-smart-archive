/**
 * Logger tests — Smart Archiver VSCode Extension
 *
 * The host renders every record to a plain OutputChannel via appendLine
 * (unfiltered), and a log-level change clears the panel and re-renders it
 * from the history buffer in sequence order. These tests verify the
 * production-level semantics of logger.setLevel() on the shared
 * logger-core pino instance and that re-rendering keeps chronology.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { Writable } from "stream";
import { setLoggerSink } from "../src/utils/logger-core";
import { logger } from "../src/utils/logger";

const flush = () => new Promise((r) => setTimeout(r, 50));

/** Extract the event name (e.g. "info.before") from a rendered line. */
const eventsFrom = (rendered: string[]) =>
  rendered.map((l) => l.match(/[a-z]+\.[a-z0-9_]+/)?.[0]);

/** A plain OutputChannel double: appendLine + working clear(). */
function makeChannel() {
  const rendered: string[] = [];
  const channel = {
    appendLine: vi.fn((line: string) => {
      rendered.push(line);
    }),
    clear: vi.fn(() => {
      rendered.length = 0;
    }),
    show: vi.fn(),
    dispose: vi.fn(),
  };
  return { channel, rendered };
}

async function freshLoggerAndChannel() {
  vi.resetModules();
  const { logger: freshLogger } = await import("../src/utils/logger");
  const vs = await import("vscode");
  const { channel, rendered } = makeChannel();
  const spy = vi
    .spyOn(vs.window, "createOutputChannel")
    .mockReturnValue(channel as unknown as vscode.OutputChannel);
  return { freshLogger, channel, rendered, spy };
}

describe("logger.setLevel", () => {
  beforeEach(() => {
    logger.setLevel("info");
  });

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

  it("renders records with a level tag and timestamp", async () => {
    const { freshLogger, rendered, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.info({ event: "fmt.info", k: "v" });
      await flush();
      expect(rendered).toHaveLength(1);
      expect(rendered[0]).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] fmt\.info k="v"$/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("renders error messages instead of [object Object] for every level", async () => {
    const { freshLogger, rendered, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.warn({ event: "err.warn", err: new Error("boom message") });
      freshLogger.info({ event: "err.info", err: { name: "ErrnoError", errno: 44 } });
      freshLogger.error({ event: "err.error", err: new Error("fatal error") });
      await flush();

      expect(rendered.some((l) => l.includes("err.warn") && l.includes("boom message"))).toBe(true);
      expect(
        rendered.some((l) => l.includes("err.info") && l.includes("ErrnoError: errno=44")),
      ).toBe(true);
      expect(rendered.some((l) => l.includes("err.error") && l.includes("fatal error"))).toBe(true);
      expect(rendered.join("\n")).not.toContain("[object Object]");
    } finally {
      spy.mockRestore();
    }
  });

  it("raising the level preserves rendered history and streams debug live", async () => {
    const { freshLogger, channel, rendered, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.info({ event: "info.before" });
      freshLogger.debug({ event: "gone.one" }); // dropped by pino at info
      await flush();
      expect(eventsFrom(rendered)).toEqual(["info.before"]);

      // Raising re-renders the panel from history — the info line survives
      // the rebuild (there is nothing hidden to reveal: pino never emitted
      // debug records while the level was info).
      freshLogger.setLevel("debug");
      await flush();
      expect(channel.clear).toHaveBeenCalledTimes(1);
      expect(eventsFrom(rendered)).toEqual(["info.before"]);

      // Debug records now stream live, interleaved with the re-rendered
      // history in chronological order.
      freshLogger.debug({ event: "live.one" });
      freshLogger.info({ event: "info.after" });
      await flush();
      expect(eventsFrom(rendered)).toEqual([
        "info.before",
        "live.one",
        "info.after",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("setLevel('info') removes debug lines from the panel", async () => {
    const { freshLogger, rendered, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.setLevel("debug");
      freshLogger.debug({ event: "mode.debug1" });
      freshLogger.info({ event: "mode.info" });
      freshLogger.debug({ event: "mode.debug2" });
      await flush();
      expect(eventsFrom(rendered)).toEqual([
        "mode.debug1",
        "mode.info",
        "mode.debug2",
      ]);

      // Lowering re-renders at the info floor: debug lines disappear, the
      // info line keeps its position.
      freshLogger.setLevel("info");
      await flush();
      expect(eventsFrom(rendered)).toEqual(["mode.info"]);

      // New debug records are dropped by pino entirely.
      freshLogger.debug({ event: "mode.hidden" });
      await flush();
      expect(eventsFrom(rendered)).toEqual(["mode.info"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("bounces between levels without losing or duplicating records", async () => {
    const { freshLogger, rendered, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.setLevel("debug");
      freshLogger.debug({ event: "b.one" });
      freshLogger.info({ event: "b.two" });
      await flush();
      expect(eventsFrom(rendered)).toEqual(["b.one", "b.two"]);

      freshLogger.setLevel("info");
      await flush();
      expect(eventsFrom(rendered)).toEqual(["b.two"]);

      freshLogger.setLevel("debug");
      await flush();
      expect(eventsFrom(rendered)).toEqual(["b.one", "b.two"]);

      // Same-level calls are no-ops (no extra re-render).
      const renderedBefore = [...rendered];
      freshLogger.setLevel("debug");
      await flush();
      expect(rendered).toEqual(renderedBefore);
    } finally {
      spy.mockRestore();
    }
  });

  it("rebuilds on a fresh channel after dispose (re-activation)", async () => {
    const { freshLogger, rendered, spy } = await freshLoggerAndChannel();
    try {
      freshLogger.setLevel("debug");
      freshLogger.debug({ event: "life.before" });
      await flush();
      expect(eventsFrom(rendered)).toEqual(["life.before"]);

      freshLogger.dispose();
      // A fresh channel on re-activation: prior history is gone, the new
      // channel renders only post-reactivation records.
      const channel2 = {
        appendLine: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
      };
      spy.mockReturnValue(channel2 as unknown as vscode.OutputChannel);

      // The first setLevel of a session rebuilds even when the level is
      // unchanged — this purges stale content the output panel may have
      // restored across a window reload.
      freshLogger.setLevel("info");
      expect(channel2.clear).toHaveBeenCalledTimes(1);

      freshLogger.setLevel("debug");
      freshLogger.debug({ event: "life.after" });
      await flush();
      expect(
        (channel2.appendLine as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes("life.after"),
        ),
      ).toBe(true);
      expect(
        (channel2.appendLine as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes("life.before"),
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
