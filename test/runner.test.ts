/**
 * Runner tests — Smart Archive VSCode Extension
 *
 * WorkerThreadRunner protocol tests with a fake Worker: spawn/init,
 * request flow, progress forwarding, cancellation, error mapping, queueing,
 * crash recovery, dispose.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import {
  WorkerThreadRunner,
  InProcessRunner,
  setArchiveRunner,
  runArchiveOp,
} from "../src/engines/worker/runner";

class FakeWorker {
  posted: unknown[] = [];
  messageHandlers: Array<(m: unknown) => void> = [];
  errorHandlers: Array<(e: Error) => void> = [];
  exitHandlers: Array<(code: number) => void> = [];
  terminated = false;

  constructor(public workerPath: string) {}

  postMessage(m: unknown): void {
    this.posted.push(m);
  }

  on(event: string, cb: (...args: never[]) => void): FakeWorker {
    if (event === "message") this.messageHandlers.push(cb);
    else if (event === "error") this.errorHandlers.push(cb);
    else if (event === "exit") this.exitHandlers.push(cb);
    return this;
  }

  off(): FakeWorker {
    return this;
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  emitMessage(m: unknown): void {
    for (const h of this.messageHandlers) h(m);
  }

  emitError(e: Error): void {
    for (const h of this.errorHandlers) h(e);
  }

  emitExit(code: number): void {
    for (const h of this.exitHandlers) h(code);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeToken(initialAborted = false) {
  let aborted = initialAborted;
  const listeners: Array<() => void> = [];
  return {
    get isCancellationRequested() {
      return aborted;
    },
    onCancellationRequested(cb: () => void) {
      listeners.push(cb);
      return { dispose: () => {} };
    },
    abort() {
      aborted = true;
      for (const l of listeners) l();
    },
  };
}

const payload = { options: { inputPath: "/tmp/x.7z", outputDir: "/tmp/out", password: "" } };

let workers: FakeWorker[];

function makeRunner(): { runner: WorkerThreadRunner; workers: FakeWorker[] } {
  workers = [];
  const runner = new WorkerThreadRunner((_path) => {
    const w = new FakeWorker(_path);
    workers.push(w);
    return w as unknown as import("worker_threads").Worker;
  });
  return { runner, workers };
}

function sentRequests(worker: FakeWorker): Array<{ type: "request"; id: number; op: string }> {
  return worker.posted.filter(
    (m): m is { type: "request"; id: number; op: string } =>
      (m as { type: string }).type === "request",
  );
}

beforeEach(() => {
  setArchiveRunner(new InProcessRunner());
});

describe("WorkerThreadRunner", () => {
  it("spawns a worker, sends init, then the request, and resolves on done", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const promise = runner.run("decompress", payload);
    await sleep(0);
    expect(wkrs).toHaveLength(1);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);

    const init = wkrs[0].posted.find((m) => (m as { type: string }).type === "init") as {
      type: string;
      config: { locale: string };
    };
    expect(init?.type).toBe("init");
    expect(init?.config.locale).toBe("en");

    const sent = sentRequests(wkrs[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("decompress");

    wkrs[0].emitMessage({ type: "done", id: sent[0].id });
    await expect(promise).resolves.toBeUndefined();
  });

  it("forwards progress messages to the caller", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const reports: Array<{ message?: string; increment?: number }> = [];
    const promise = runner.run("decompress", payload, { report: (v) => reports.push(v) });
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);
    const [req] = sentRequests(wkrs[0]);
    wkrs[0].emitMessage({ type: "progress", id: req.id, message: "45%", increment: 45 });
    wkrs[0].emitMessage({ type: "done", id: req.id });
    await promise;
    expect(reports).toEqual([{ message: "45%", increment: 45 }]);
  });

  it("forwards notify warnings to vscode.window", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    const { runner, workers: wkrs } = makeRunner();
    const promise = runner.run("decompress", payload);
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);
    const [req] = sentRequests(wkrs[0]);
    wkrs[0].emitMessage({ type: "notify", message: "zstd not available" });
    wkrs[0].emitMessage({ type: "done", id: req.id });
    await promise;
    expect(warn).toHaveBeenCalledWith("zstd not available");
    warn.mockRestore();
  });

  it("rejects immediately when the token is already cancelled", async () => {
    const { runner, workers: wkrs } = makeRunner();
    await expect(
      runner.run("decompress", payload, undefined, makeToken(true)),
    ).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(wkrs).toHaveLength(0);
  });

  it("sends a cancel message when the token cancels mid-flight", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const token = makeToken();
    const promise = runner.run("decompress", payload, undefined, token);
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);
    const [req] = sentRequests(wkrs[0]);
    token.abort();
    expect(wkrs[0].posted).toContainEqual({ type: "cancel", id: req.id });
    wkrs[0].emitMessage({ type: "error", id: req.id, message: "Cancelled", cancelled: true });
    await expect(promise).rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it("rejects a queued request on cancellation without sending it", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const first = runner.run("decompress", payload);
    const token = makeToken();
    const second = runner.run("decompress", payload, undefined, token);
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);
    token.abort();
    await expect(second).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(sentRequests(wkrs[0])).toHaveLength(1);
    const [req] = sentRequests(wkrs[0]);
    wkrs[0].emitMessage({ type: "done", id: req.id });
    await first;
  });

  it("maps cancelled worker errors to vscode.CancellationError and other errors to Error", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const p1 = runner.run("decompress", payload);
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);
    const [req1] = sentRequests(wkrs[0]);
    wkrs[0].emitMessage({ type: "error", id: req1.id, message: "boom", stack: "at x" });
    await expect(p1).rejects.toMatchObject({ message: "boom", stack: "at x" });

    const p2 = runner.run("decompress", payload);
    await sleep(0);
    const all = sentRequests(wkrs[0]);
    expect(all).toHaveLength(2);
    wkrs[0].emitMessage({ type: "error", id: all[1].id, message: "Cancelled", cancelled: true });
    await expect(p2).rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it("queues requests FIFO and runs them one at a time", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const p1 = runner.run("decompress", payload);
    const p2 = runner.run("decompress", payload);
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);
    expect(sentRequests(wkrs[0])).toHaveLength(1); // only the first is sent

    const [req1] = sentRequests(wkrs[0]);
    wkrs[0].emitMessage({ type: "done", id: req1.id });
    await p1;
    await sleep(0);
    const all = sentRequests(wkrs[0]);
    expect(all).toHaveLength(2); // second sent after first completed
    wkrs[0].emitMessage({ type: "done", id: all[1].id });
    await p2;
  });

  it("rejects the in-flight request and respawns after a worker crash", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const p1 = runner.run("decompress", payload);
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    await sleep(0);
    wkrs[0].emitError(new Error("segfault"));
    await expect(p1).rejects.toThrow(/crashed/);

    const p2 = runner.run("decompress", payload);
    await sleep(0);
    expect(wkrs).toHaveLength(2);
    wkrs[1].emitMessage({ type: "ready" });
    await sleep(0);
    const [req] = sentRequests(wkrs[1]);
    expect(req).toBeDefined();
    wkrs[1].emitMessage({ type: "done", id: req.id });
    await p2;
  });

  it("dispose rejects pending requests and shuts the worker down", async () => {
    const { runner, workers: wkrs } = makeRunner();
    const p1 = runner.run("decompress", payload);
    await sleep(0);
    wkrs[0].emitMessage({ type: "ready" });
    runner.dispose();
    await expect(p1).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(wkrs[0].posted).toContainEqual({ type: "shutdown" });
  });
});

describe("runArchiveOp dispatcher", () => {
  it("routes through the active runner", async () => {
    const mockRun = vi.fn().mockResolvedValue(undefined);
    setArchiveRunner({ run: mockRun, dispose: () => {} });
    await runArchiveOp("decompress", payload);
    expect(mockRun).toHaveBeenCalledWith("decompress", payload, undefined, undefined);
  });
});
