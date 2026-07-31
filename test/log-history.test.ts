/**
 * LogHistory unit tests — Smart Archive VSCode Extension
 *
 * Covers the byte-budgeted ring buffer: budget eviction, seq-cursor
 * alignment across rollover, snapshot semantics (records pushed during a
 * replay are not replayed), level filtering, and reset.
 */

import { describe, it, expect } from "vitest";
import { LogHistory } from "../src/utils/log-history";

const D = 20; // debug
const I = 30; // info
const W = 40; // warn
const E = 50; // error

describe("LogHistory", () => {
  it("appends records and reports cursor/size", () => {
    const h = new LogHistory(1024);
    h.push(D, '{"level":20,"event":"a"}');
    h.push(I, '{"level":30,"event":"b"}');
    expect(h.size).toBe(2);
    expect(h.cursor).toBe(2);
  });

  it("evicts oldest records while over the byte budget", () => {
    const h = new LogHistory(60);
    // Each line is exactly 32 bytes; 32+32=64 > 60 → oldest dropped each push.
    h.push(D, '{"level":20,"event":"aaaaaaaaaa"}');
    h.push(I, '{"level":30,"event":"bbbbbbbbbb"}');
    h.push(W, '{"level":40,"event":"cccccccccc"}');
    expect(h.size).toBe(1);
    expect(h.byteSize).toBeLessThanOrEqual(60);
    const replayed: string[] = [];
    const cursor = h.replayFrom(0, D, (l) => replayed.push(l));
    expect(replayed).toEqual(['{"level":40,"event":"cccccccccc"}']);
    expect(cursor).toBe(3);
  });

  it("replays records above the min level only", () => {
    const h = new LogHistory(1024);
    h.push(D, "d1");
    h.push(I, "i1");
    h.push(W, "w1");
    h.push(E, "e1");

    const infoView: string[] = [];
    h.replayFrom(0, I, (l) => infoView.push(l));
    expect(infoView).toEqual(["i1", "w1", "e1"]); // debug excluded

    const warnView: string[] = [];
    h.replayFrom(0, W, (l) => warnView.push(l));
    expect(warnView).toEqual(["w1", "e1"]);
  });

  it("never replays the same record twice across cursor updates", () => {
    const h = new LogHistory(1024);
    h.push(D, "d1");
    h.push(I, "i1");
    const first: string[] = [];
    const cursor = h.replayFrom(0, D, (l) => first.push(l));
    expect(first).toEqual(["d1", "i1"]);

    h.push(W, "w1");
    const second: string[] = [];
    h.replayFrom(cursor, D, (l) => second.push(l));
    expect(second).toEqual(["w1"]); // d1/i1 not replayed
  });

  it("keeps the cursor correct across budget rollover (no duplicates)", () => {
    const h = new LogHistory(40); // fits one 32-byte line, evicts on the second
    h.push(D, '{"level":20,"event":"aaaaaaaaaa"}');
    const first: string[] = [];
    const cursor = h.replayFrom(0, D, (l) => first.push(l));
    expect(first).toHaveLength(1);

    // More records evict the first one; cursor must stay ahead of it.
    h.push(D, '{"level":20,"event":"bbbbbbbbbb"}');
    h.push(D, '{"level":20,"event":"cccccccccc"}');
    expect(h.size).toBe(1); // only the latest survived
    const second: string[] = [];
    const cursor2 = h.replayFrom(cursor, D, (l) => second.push(l));
    expect(second).toHaveLength(1); // only the newest, not the evicted one
    expect(cursor2).toBe(h.cursor);
  });

  it("snapshots the end boundary: pushes during a replay are not replayed", () => {
    const h = new LogHistory(1024);
    h.push(D, "d1");
    h.push(I, "i1");

    const seen: string[] = [];
    let midPushCursor = 0;
    const out = (line: string) => {
      seen.push(line);
      if (line === "i1") {
        // Simulate a concurrent push while the replay loop is in flight.
        h.push(W, "w1");
        midPushCursor = h.cursor;
      }
    };
    const cursor = h.replayFrom(0, D, out);
    expect(seen).toEqual(["d1", "i1"]);
    expect(cursor).toBe(3); // w1's seq advanced the cursor
    expect(midPushCursor).toBe(3);

    // w1 was delivered live outside the replay; replaying from the cursor
    // must not deliver it again (it is already at/below the cursor).
    const again: string[] = [];
    h.replayFrom(cursor, D, (l) => again.push(l));
    expect(again).toEqual([]);
  });

  it("never replays records that were already visible when produced", () => {
    const h = new LogHistory(1024);
    h.push(W, "w-visible", true); // shown live by a Warning panel
    h.push(I, "i-hidden", false); // hidden at the time
    const replayed: string[] = [];
    h.replayFrom(0, I, (l) => replayed.push(l));
    expect(replayed).toEqual(["i-hidden"]); // visible warn excluded
  });

  it("reset clears records and restarts sequencing", () => {
    const h = new LogHistory(1024);
    h.push(D, "d1");
    h.reset();
    expect(h.size).toBe(0);
    expect(h.byteSize).toBe(0);
    expect(h.cursor).toBe(0);
    h.push(D, "d2");
    const replayed: string[] = [];
    h.replayFrom(0, D, (l) => replayed.push(l));
    expect(replayed).toEqual(["d2"]);
  });
});
