/**
 * Compress-wizard state machine tests — Smart Archive
 *
 * Drives the real wizard code with a programmable vscode mock to verify
 * the RAR flow: forced header encryption, split-volume recovery volumes
 * (exact count) vs inline recovery record (percent), and the final
 * options passed to the compress engine.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

vi.mock("../src/engines/js7z-compress", () => ({
  compressWith7z: vi.fn(async () => {}),
}));

import { compressCommand } from "../src/commands/compress";
import { compressWith7z } from "../src/engines/js7z-compress";

const compressWith7zMock = vi.mocked(compressWith7z);

interface Qp {
  items: { label: string; value?: unknown }[];
  selectedItems: { label: string; value?: unknown }[];
  _accept?: () => void;
  _hide?: () => void;
  show: () => void;
  hide: () => void;
}
interface Ib {
  value: string;
  _accept?: () => void;
  _hide?: () => void;
  show: () => void;
  hide: () => void;
}

function installDriver(): { qps: Qp[]; ibs: Ib[] } {
  const qps: Qp[] = [];
  const ibs: Ib[] = [];
  (vscode.window as any).createQuickPick = () => {
    const qp: Qp = {
      items: [],
      selectedItems: [],
      show: () => {
        qps.push(qp);
        process.stdout.write("QP-SHOW: " + JSON.stringify(qp.items.map((i) => i.label)) + "\n");
      },
      hide: () => qp._hide?.(),
    };
    (qp as any).onDidAccept = (cb: () => void) => {
      (qp as any)._accept = cb;
    };
    (qp as any).onDidHide = (cb: () => void) => {
      (qp as any)._hide = cb;
    };
    (qp as any).onDidTriggerButton = () => {};
    (qp as any).onDidChangeSelection = () => {};
    return qp;
  };
  (vscode.window as any).createInputBox = () => {
    const ib: Ib = {
      value: "",
      show: () => ibs.push(ib),
      hide: () => ib._hide?.(),
    };
    (ib as any).onDidAccept = (cb: () => void) => {
      (ib as any)._accept = cb;
    };
    (ib as any).onDidHide = (cb: () => void) => {
      (ib as any)._hide = cb;
    };
    (ib as any).onDidTriggerButton = () => {};
    (ib as any).onDidChangeValue = () => {};
    return ib;
  };
  (vscode.window as any).withProgress = async (_o: unknown, task: (p: unknown) => unknown) =>
    task({ report: () => {} });
  (vscode.window as any).showSaveDialog = async () => vscode.Uri.file("/tmp/out.rar");
  return { qps, ibs };
}

async function pickLabel(qp: Qp, label: string): Promise<void> {
  const item = qp.items.find((i) => i.label === label);
  expect(item, `wizard option "${label}" not offered (got: ${qp.items.map((i) => i.label).join(", ")})`).toBeTruthy();
  qp.selectedItems = [item!];
  qp._accept!();
  qp.hide();
  await Promise.resolve();
  await Promise.resolve();
}

async function typeValue(ib: Ib, value: string): Promise<void> {
  ib.value = value;
  ib._accept!();
  ib.hide();
  await Promise.resolve();
  await Promise.resolve();
}

describe("compress wizard (RAR)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "sat_wiz-"));
    fs.writeFileSync(path.join(dir, "data.bin"), require("crypto").randomBytes(50000));
    compressWith7zMock.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("encryption forces header encryption; split RAR offers recovery volumes by count", async () => {
    const { qps, ibs } = installDriver();
    const uri = vscode.Uri.file(dir);

    const p = compressCommand(uri, []).catch((e) => {
      process.stdout.write("CMD-ERR: " + (e instanceof Error ? e.message : String(e)) + "\n");
      throw e;
    });
    // 1. format
    await vi.waitFor(() => expect(qps.length).toBe(1));
    await pickLabel(qps[0], "rar");
    // 2. level
    await vi.waitFor(() => expect(qps.length).toBe(2));
    await pickLabel(qps[1], qps[1].items[0].label);
    // 3. volume — custom 32k
    await vi.waitFor(() => expect(qps.length).toBe(3));
    await pickLabel(qps[2], qps[2].items[qps[2].items.length - 1].label); // Custom...
    await vi.waitFor(() => expect(ibs.length).toBe(1));
    await typeValue(ibs[0], "32k");
    // 4. encryption — yes (forces header encryption)
    await vi.waitFor(() => expect(qps.length).toBe(4));
    await pickLabel(qps[3], qps[3].items.find((i) => i.value === true)!.label);
    // 5. password
    await vi.waitFor(() => expect(ibs.length).toBe(2));
    await typeValue(ibs[1], "pw");
    // 5.6 recovery volumes — the wizard must show count options (not percent)
    await vi.waitFor(() => expect(qps.length).toBe(5));
    const recoveryQp = qps[4];
    const labels = recoveryQp.items.map((i) => i.label);
    expect(labels.some((l) => /recovery volume/.test(l)), `expected count options, got: ${labels.join(", ")}`).toBe(true);
    expect(labels.some((l) => /of archive size/.test(l)), "must NOT offer archive-size percent for split RAR").toBe(false);
    await pickLabel(recoveryQp, recoveryQp.items.find((i) => i.value === 2)!.label);
    // 6. save name
    await vi.waitFor(() => expect(ibs.length).toBe(3));
    await typeValue(ibs[2], "out");

    await p;
    expect(compressWith7zMock).toHaveBeenCalledTimes(1);
    const options = compressWith7zMock.mock.calls[0][0] as {
      encryptHeaders?: boolean;
      recoveryPercent?: number;
      recoveryVolumeCount?: number;
      volumeSize?: string;
    };
    expect(options.encryptHeaders).toBe(true);
    expect(options.recoveryVolumeCount).toBe(2);
    expect(options.recoveryPercent).toBe(0);
    expect(options.volumeSize).toBe("32k");
  });

  it("non-split RAR offers the inline recovery record percent", async () => {
    const { qps, ibs } = installDriver();
    const uri = vscode.Uri.file(dir);

    const p = compressCommand(uri, []);
    await vi.waitFor(() => expect(qps.length).toBe(1));
    await pickLabel(qps[0], "rar");
    await vi.waitFor(() => expect(qps.length).toBe(2));
    await pickLabel(qps[1], qps[1].items[0].label);
    // volume — don't split
    await vi.waitFor(() => expect(qps.length).toBe(3));
    await pickLabel(qps[2], qps[2].items[0].label);
    // encryption — no
    await vi.waitFor(() => expect(qps.length).toBe(4));
    await pickLabel(qps[3], qps[3].items.find((i) => i.value === false)!.label);
    // recovery record — percent options
    await vi.waitFor(() => expect(qps.length).toBe(5));
    const recoveryQp = qps[4];
    expect(recoveryQp.items.some((i) => /of archive size/.test(i.label))).toBe(true);
    await pickLabel(recoveryQp, recoveryQp.items.find((i) => i.value === 5)!.label);
    // save — non-split uses the save dialog
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as {
      encryptHeaders?: boolean;
      recoveryPercent?: number;
      recoveryVolumeCount?: number;
    };
    expect(options.recoveryPercent).toBe(5);
    expect(options.recoveryVolumeCount).toBe(0);
    expect(options.encryptHeaders).toBe(false);
  });
});
