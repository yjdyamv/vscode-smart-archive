/**
 * Compress-wizard state machine tests — Smart Archive
 *
 * Drives the real wizard code with the scriptable vscode test double to
 * verify the RAR flow: forced header encryption, split-volume recovery
 * volumes (exact count) vs inline recovery record (percent), and the
 * final options passed to the compress engine. The engine call itself is
 * mocked here — the decision tables under test live in the command; the
 * engine behind the seam is exercised end-to-end in commands-e2e.test.ts.
 */
import * as fs from "fs";
import * as path from "path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  __quickPicks,
  __inputBoxes,
  __setSaveDialogResult,
} from "./__mocks__/vscode";

vi.mock("../src/engines/js7z-compress", () => ({
  compressWith7z: vi.fn(async () => {}),
}));

import { compressCommand } from "../src/commands/compress";
import { compressWith7z } from "../src/engines/js7z-compress";
import { tmpDir } from "./tmp";

const compressWith7zMock = vi.mocked(compressWith7z);

interface Qp {
  items: { label: string; value?: unknown }[];
  accept: (item?: { label: string; value?: unknown }) => void;
}
interface Ib {
  value: string;
  accept: (value?: string) => void;
}

function currentQuickPick(nth: number): Qp {
  const qp = __quickPicks()[nth - 1] as unknown as Qp;
  expect(qp, `quick pick #${nth} not created`).toBeTruthy();
  return qp;
}

function currentInputBox(nth: number): Ib {
  const ib = __inputBoxes()[nth - 1] as unknown as Ib;
  expect(ib, `input box #${nth} not created`).toBeTruthy();
  return ib;
}

async function pickLabel(qp: Qp, label: string): Promise<void> {
  const item = qp.items.find((i) => i.label === label);
  expect(item, `wizard option "${label}" not offered (got: ${qp.items.map((i) => i.label).join(", ")})`).toBeTruthy();
  qp.accept(item!);
  await Promise.resolve();
  await Promise.resolve();
}

async function typeValue(ib: Ib, value: string): Promise<void> {
  ib.accept(value);
  await Promise.resolve();
  await Promise.resolve();
}

describe("compress wizard (RAR)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("sat_wiz-");
    fs.writeFileSync(path.join(dir, "data.bin"), require("crypto").randomBytes(50000));
    __setSaveDialogResult(vscode.Uri.file("/tmp/out.rar"));
    compressWith7zMock.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("encryption forces header encryption; split RAR offers recovery volumes by count", async () => {
    const uri = vscode.Uri.file(dir);

    const p = compressCommand(uri, []).catch((e) => {
      process.stdout.write("CMD-ERR: " + (e instanceof Error ? e.message : String(e)) + "\n");
      throw e;
    });
    // 1. format
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    // 2. level
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    // 3. volume — custom 32k
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(currentQuickPick(3), currentQuickPick(3).items[currentQuickPick(3).items.length - 1].label); // Custom...
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
    await typeValue(currentInputBox(1), "32k");
    // 4. encryption — yes (forces header encryption)
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(currentQuickPick(4), currentQuickPick(4).items.find((i) => i.value === true)!.label);
    // 5. password
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "pw");
    // 5.6 recovery volumes — the wizard must show count options (not percent)
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    const recoveryQp = currentQuickPick(5);
    const labels = recoveryQp.items.map((i) => i.label);
    expect(labels.some((l) => /recovery volume/.test(l)), `expected count options, got: ${labels.join(", ")}`).toBe(true);
    expect(labels.some((l) => /of archive size/.test(l)), "must NOT offer archive-size percent for split RAR").toBe(false);
    await pickLabel(recoveryQp, recoveryQp.items.find((i) => i.value === 2)!.label);
    // 6. save name
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(3));
    await typeValue(currentInputBox(3), "out");

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
    const uri = vscode.Uri.file(dir);

    const p = compressCommand(uri, []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    // volume — don't split
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label);
    // encryption — no
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(currentQuickPick(4), currentQuickPick(4).items.find((i) => i.value === false)!.label);
    // recovery record — percent options
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    const recoveryQp = currentQuickPick(5);
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
