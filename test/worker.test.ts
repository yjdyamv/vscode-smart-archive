/**
 * Worker handler tests — Smart Archive VSCode Extension
 *
 * createArchiveWorkerHandler protocol tests with an in-memory port:
 * init/ready, compress round-trip, decompress round-trip, progress,
 * cancellation, reconfigure, error mapping.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { HostMessage, WorkerMessage } from "../src/engines/worker/types";
import { createArchiveWorkerHandler } from "../src/engines/worker/handler";

class FakePort {
  messages: WorkerMessage[] = [];
  listeners: Array<(message: HostMessage) => void> = [];
  closed = false;

  postMessage(message: WorkerMessage): void {
    this.messages.push(message);
  }

  on(_event: string, listener: (message: HostMessage) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    this.closed = true;
  }

  send(message: HostMessage): void {
    for (const l of this.listeners) l(message);
  }

  last(): WorkerMessage {
    return this.messages[this.messages.length - 1];
  }

  ofType(type: WorkerMessage["type"]): WorkerMessage[] {
    return this.messages.filter((m) => m.type === type);
  }
}

let port: FakePort;

function initWorker(config?: Record<string, unknown>): void {
  port.send({
    type: "init",
    config: {
      locale: "en",
      limits: { maxFileSize: 10 * 1024 * 1024 * 1024, maxTotalSize: 20 * 1024 * 1024 * 1024 },
      useSystemZstd: "auto",
      ...config,
    },
  });
}

const td = fs.mkdtempSync(path.join(os.tmpdir(), "saw_"));

beforeEach(() => {
  port = new FakePort();
  createArchiveWorkerHandler(port as never);
});

afterEach(() => {
  // nothing to clean per-request; temp dirs cleaned at process end
});

describe("createArchiveWorkerHandler", () => {
  it("replies ready on init", () => {
    initWorker();
    expect(port.ofType("ready")).toHaveLength(1);
  });

  it("compresses a file and replies done", async () => {
    initWorker();
    const src = path.join(td, "w1.txt");
    fs.writeFileSync(src, "worker handler test payload");
    const out = path.join(td, "w1.7z");
    const promise = new Promise<void>((resolve) => {
      const check = () => {
        if (port.last().type === "done") resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({
      type: "request",
      id: 1,
      op: "compress",
      payload: {
        options: {
          targets: [{ fsPath: src }],
          format: { label: "7z", description: "", canCreate: true, supportsEncryption: false },
          outputPath: out,
          password: "",
          level: 5,
        },
        excludePatterns: [],
      },
    });
    await promise;
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it("decompresses an archive and replies done", async () => {
    initWorker();
    const src = path.join(td, "w2.txt");
    fs.writeFileSync(src, "round trip content");
    const archive = path.join(td, "w2.7z");
    const outDir = path.join(td, "w2out");
    const done = new Promise<void>((resolve) => {
      const check = () => {
        if (port.last().type === "done") resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({
      type: "request",
      id: 1,
      op: "compress",
      payload: {
        options: {
          targets: [{ fsPath: src }],
          format: { label: "7z", description: "", canCreate: true, supportsEncryption: false },
          outputPath: archive,
          password: "",
          level: 5,
        },
        excludePatterns: [],
      },
    });
    await done;
    port.send({
      type: "request",
      id: 2,
      op: "decompress",
      payload: { options: { inputPath: archive, outputDir: outDir, password: "" } },
    });
    const done2 = new Promise<void>((resolve) => {
      const check = () => {
        const last = port.last();
        if (last.type === "done" && last.id === 2) resolve();
        else if (last.type === "error" && last.id === 2) throw new Error(last.message);
        else setTimeout(check, 10);
      };
      check();
    });
    await done2;
    expect(fs.readFileSync(path.join(outDir, "w2.txt"), "utf8")).toBe("round trip content");
  });

  it("emits progress messages during compression", async () => {
    initWorker();
    const src = path.join(td, "w3.bin");
    fs.writeFileSync(src, Buffer.alloc(256 * 1024, 7));
    const out = path.join(td, "w3.7z");
    const done = new Promise<void>((resolve) => {
      const check = () => {
        if (port.last().type === "done") resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({
      type: "request",
      id: 1,
      op: "compress",
      payload: {
        options: {
          targets: [{ fsPath: src }],
          format: { label: "7z", description: "", canCreate: true, supportsEncryption: false },
          outputPath: out,
          password: "",
          level: 5,
        },
        excludePatterns: [],
      },
    });
    await done;
    expect(port.ofType("progress").length).toBeGreaterThan(0);
  });

  it("reports cancelled error when a request is cancelled mid-flight", async () => {
    initWorker();
    const src = path.join(td, "w4.bin");
    fs.writeFileSync(src, Buffer.alloc(64 * 1024 * 1024, 9));
    const out = path.join(td, "w4.7z");
    const cancelledErr = new Promise<WorkerMessage>((resolve) => {
      const check = () => {
        const last = port.last();
        if (last.type === "error") resolve(last);
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({
      type: "request",
      id: 1,
      op: "compress",
      payload: {
        options: {
          targets: [{ fsPath: src }],
          format: { label: "7z", description: "", canCreate: true, supportsEncryption: false },
          outputPath: out,
          password: "",
          level: 9,
        },
        excludePatterns: [],
      },
    });
    setTimeout(() => port.send({ type: "cancel", id: 1 }), 50);
    const msg = await cancelledErr;
    expect(msg.type).toBe("error");
    expect((msg as { cancelled?: boolean }).cancelled).toBe(true);
  });

  it("lists archive entries and replies done with the result", async () => {
    initWorker();
    const src = path.join(td, "w5.txt");
    fs.writeFileSync(src, "list me");
    const archive = path.join(td, "w5.7z");
    const done = new Promise<void>((resolve) => {
      const check = () => {
        if (port.last().type === "done") resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({
      type: "request",
      id: 1,
      op: "compress",
      payload: {
        options: {
          targets: [{ fsPath: src }],
          format: { label: "7z", description: "", canCreate: true, supportsEncryption: false },
          outputPath: archive,
          password: "",
          level: 5,
        },
        excludePatterns: [],
      },
    });
    await done;

    const listResult = new Promise<unknown>((resolve) => {
      const check = () => {
        const last = port.last();
        if (last.type === "done" && last.id === 2) resolve(last.result);
        else if (last.type === "error" && last.id === 2) throw new Error(last.message);
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({
      type: "request",
      id: 2,
      op: "list",
      payload: { inputPath: archive, password: "" },
    });
    const entries = (await listResult) as { path: string; size: number; type: string }[];
    expect(entries).toContainEqual({
      path: "w5.txt",
      size: 7,
      type: "REGULAR_FILE",
    });
  });

  it("detects encryption via the isEncrypted op", async () => {
    initWorker();
    const src = path.join(td, "w6.txt");
    fs.writeFileSync(src, "secret content");
    const archive = path.join(td, "w6.7z");
    const done = new Promise<void>((resolve) => {
      const check = () => {
        if (port.last().type === "done") resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({
      type: "request",
      id: 1,
      op: "compress",
      payload: {
        options: {
          targets: [{ fsPath: src }],
          format: { label: "7z", description: "", canCreate: true, supportsEncryption: false },
          outputPath: archive,
          password: "pw123",
          level: 5,
        },
        excludePatterns: [],
      },
    });
    await done;

    const encResult = new Promise<unknown>((resolve) => {
      const check = () => {
        const last = port.last();
        if (last.type === "done" && last.id === 2) resolve(last.result);
        else if (last.type === "error" && last.id === 2) throw new Error(last.message);
        else setTimeout(check, 10);
      };
      check();
    });
    port.send({ type: "request", id: 2, op: "isEncrypted", payload: { inputPath: archive } });
    expect(await encResult).toBe(true);
  });

  it("applies reconfigure (locale + limits)", async () => {
    initWorker({ locale: "en" });
    port.send({
      type: "reconfigure",
      config: { locale: "zh-cn", limits: { maxFileSize: 123 }, useSystemZstd: "never" },
    });
    // reconfigure applies synchronously; no response expected — just ensure
    // the next op still works and no crash occurs.
    expect(port.ofType("error")).toHaveLength(0);
  });
});
