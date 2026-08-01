/**
 * Router burst-log tests — Smart Archive VSCode Extension
 *
 * expandDir/saveExpanded are high-frequency webview messages (opening an
 * archive with many restored expanded paths bursts dozens at once). Their
 * debug logging must aggregate per webview and per message type: the first
 * message of each type logs immediately, the burst settles into one "×N"
 * summary line per type, and the counters reset for the next burst.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerHandler, disposeBurstLoggers } from "../src/providers/webview/router";
import { logger } from "../src/utils/logger";

function makeWebview() {
  const listeners: Array<(msg: unknown) => void> = [];
  const webview = {
    onDidReceiveMessage: vi.fn((cb: (msg: unknown) => void) => listeners.push(cb)),
    postMessage: vi.fn(),
  };
  return {
    webview,
    receive: (msg: unknown) => {
      for (const cb of listeners) cb(msg);
    },
  };
}

const callsOf = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c) => c[0] as { event?: string; c?: string; total?: number });

describe("webview burst logging", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    debugSpy.mockRestore();
    disposeBurstLoggers();
  });

  it("logs the first expandDir immediately and aggregates the burst", async () => {
    const { webview, receive } = makeWebview();
    registerHandler(webview);
    receive({ c: "expandDir", dir: "/a" });
    receive({ c: "expandDir", dir: "/b" });
    receive({ c: "expandDir", dir: "/c" });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toMatchObject({
      event: "webview.msg",
      c: "expandDir",
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy.mock.calls[1][0]).toMatchObject({
      event: "webview.msg.burst",
      c: "expandDir",
      total: 3,
    });
  });

  it("resets the burst counter after the quiet window", async () => {
    const { webview, receive } = makeWebview();
    registerHandler(webview);
    receive({ c: "expandDir", dir: "/a" });
    receive({ c: "expandDir", dir: "/b" });
    await vi.advanceTimersByTimeAsync(1100);
    receive({ c: "expandDir", dir: "/c" });
    await vi.advanceTimersByTimeAsync(1100);

    const calls = callsOf(debugSpy);
    // Two fresh burst starts (one per quiet window) — the counter did not
    // leak across the window — and one ×2 summary (the lone third message
    // is a burst of one, which logs immediately and needs no summary).
    expect(calls.filter((o) => o.event === "webview.msg")).toHaveLength(2);
    expect(calls.filter((o) => o.event === "webview.msg.burst")).toEqual([
      expect.objectContaining({ c: "expandDir", total: 2 }),
    ]);
  });

  it("summarizes each message type separately in a mixed burst", async () => {
    const { webview, receive } = makeWebview();
    registerHandler(webview);
    receive({ c: "expandDir", dir: "/a" });
    receive({ c: "expandDir", dir: "/b" });
    receive({ c: "saveExpanded", paths: ["/a"] });
    receive({ c: "saveExpanded", paths: ["/b"] });
    receive({ c: "saveExpanded", paths: ["/c"] });
    await vi.advanceTimersByTimeAsync(1100);

    const bursts = callsOf(debugSpy).filter((o) => o.event === "webview.msg.burst");
    expect(bursts).toEqual([
      expect.objectContaining({ c: "expandDir", total: 2 }),
      expect.objectContaining({ c: "saveExpanded", total: 3 }),
    ]);
  });

  it("keeps bursts isolated per webview", async () => {
    const { webview: wv1, receive: r1 } = makeWebview();
    const { webview: wv2, receive: r2 } = makeWebview();
    registerHandler(wv1);
    registerHandler(wv2);
    r1({ c: "expandDir", dir: "/a" });
    r1({ c: "expandDir", dir: "/b" });
    r2({ c: "expandDir", dir: "/c" });
    await vi.advanceTimersByTimeAsync(1100);

    const calls = callsOf(debugSpy);
    expect(calls.filter((o) => o.event === "webview.msg")).toHaveLength(2);
    expect(calls.filter((o) => o.event === "webview.msg.burst")).toEqual([
      expect.objectContaining({ c: "expandDir", total: 2 }), // only wv1 burst
    ]);
  });

  it("disposeBurstLoggers cancels pending timers", async () => {
    const { webview, receive } = makeWebview();
    registerHandler(webview);
    receive({ c: "expandDir", dir: "/a" });
    receive({ c: "expandDir", dir: "/b" });
    disposeBurstLoggers();
    await vi.advanceTimersByTimeAsync(1100);

    const calls = callsOf(debugSpy);
    expect(calls.filter((o) => o.event === "webview.msg")).toHaveLength(1);
    expect(calls.filter((o) => o.event === "webview.msg.burst")).toHaveLength(0);
  });
});
