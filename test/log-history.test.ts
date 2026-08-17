/**
 * LogHistory unit tests — Smart Archiver VSCode Extension
 *
 * Covers the byte-budgeted ring buffer: budget eviction, level-filtered
 * re-render (replayAll), budget resize, and reset.
 */

import { describe, it, expect } from "vitest";
import { LogHistory } from "../src/utils/log-history";

const D = 20; // debug
const I = 30; // info
const W = 40; // warn
const E = 50; // error

describe("LogHistory", () => {
  it("appends records and reports size/bytes", () => {
    const h = new LogHistory(1024);
    h.push(D, '{"level":20,"event":"a"}');
    h.push(I, '{"level":30,"event":"b"}');
    expect(h.size).toBe(2);
    expect(h.byteSize).toBe(48);
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
    h.replayAll(D, (l) => replayed.push(l));
    expect(replayed).toEqual(['{"level":40,"event":"cccccccccc"}']);
  });

  it("replays records above the min level only, in order", () => {
    const h = new LogHistory(1024);
    h.push(D, "d1");
    h.push(I, "i1");
    h.push(W, "w1");
    h.push(E, "e1");

    const infoView: string[] = [];
    h.replayAll(I, (l) => infoView.push(l));
    expect(infoView).toEqual(["i1", "w1", "e1"]); // debug excluded

    const warnView: string[] = [];
    h.replayAll(W, (l) => warnView.push(l));
    expect(warnView).toEqual(["w1", "e1"]);

    const all: string[] = [];
    h.replayAll(D, (l) => all.push(l));
    expect(all).toEqual(["d1", "i1", "w1", "e1"]);
  });

  it("setMaxBytes shrinks evicting the oldest records and grows keeping all", () => {
    const h = new LogHistory(1024);
    h.push(D, '{"level":20,"event":"aaaaaaaaaa"}'); // 32 bytes each
    h.push(I, '{"level":30,"event":"bbbbbbbbbb"}');
    h.push(W, '{"level":40,"event":"cccccccccc"}');
    expect(h.size).toBe(3);

    h.setMaxBytes(60); // fits one line
    expect(h.size).toBe(1);
    expect(h.byteSize).toBeLessThanOrEqual(60);
    const replayed: string[] = [];
    h.replayAll(D, (l) => replayed.push(l));
    expect(replayed).toEqual(['{"level":40,"event":"cccccccccc"}']);

    h.setMaxBytes(1024); // growing loses nothing
    h.push(E, '{"level":50,"event":"dddddddddd"}');
    expect(h.size).toBe(2);
    const all: string[] = [];
    h.replayAll(D, (l) => all.push(l));
    expect(all).toEqual([
      '{"level":40,"event":"cccccccccc"}',
      '{"level":50,"event":"dddddddddd"}',
    ]);
  });

  it("reset clears records", () => {
    const h = new LogHistory(1024);
    h.push(D, "d1");
    h.reset();
    expect(h.size).toBe(0);
    expect(h.byteSize).toBe(0);
    h.push(D, "d2");
    const replayed: string[] = [];
    h.replayAll(D, (l) => replayed.push(l));
    expect(replayed).toEqual(["d2"]);
  });
});
