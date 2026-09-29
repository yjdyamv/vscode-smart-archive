/**
 * Compress-wizard state machine tests — Smart Archiver
 *
 * Drives the real wizard code with the scriptable vscode test double to
 * verify the RAR flow: forced header encryption, the split-RAR recovery
 * steps (inline record percent, then the .rev recovery-volume count), the
 * non-split inline record, and the final options passed to the compress
 * engine. The engine call itself is
 * mocked here — the decision tables under test live in the command; the
 * engine behind the seam is exercised end-to-end in commands-e2e.test.ts.
 */
import * as fs from "fs";
import * as path from "path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { __quickPicks, __inputBoxes, __setSaveDialogResult } from "./__mocks__/vscode";

vi.mock("../src/engines/js7z-compress", () => ({
  compressWith7z: vi.fn(async () => {}),
}));

import { compressCommand } from "../src/commands/compress";
import { compressWith7z } from "../src/engines/js7z-compress";
import { tmpDir } from "./tmp";

const compressWith7zMock = vi.mocked(compressWith7z);

interface Qp {
  items: { label: string; value?: unknown; description?: string }[];
  placeholder?: string;
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
  expect(
    item,
    `wizard option "${label}" not offered (got: ${qp.items.map((i) => i.label).join(", ")})`,
  ).toBeTruthy();
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

  it("encryption forces header encryption; split RAR offers the inline record then recovery volumes", async () => {
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
    await pickLabel(
      currentQuickPick(3),
      currentQuickPick(3).items[currentQuickPick(3).items.length - 1].label,
    ); // Custom...
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
    await typeValue(currentInputBox(1), "32k");
    // 4. encryption — yes (forces header encryption)
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(
      currentQuickPick(4),
      currentQuickPick(4).items.find((i) => i.value === true)!.label,
    );
    // 5. password
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "pw");
    // 5.6 inline recovery record — split RAR offers the per-volume percent
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    const recordQp = currentQuickPick(5);
    const recordLabels = recordQp.items.map((i) => i.label);
    expect(
      recordLabels.some((l) => /of each volume/.test(l)),
      `expected per-volume percent, got: ${recordLabels.join(", ")}`,
    ).toBe(true);
    await pickLabel(recordQp, recordQp.items.find((i) => i.value === 5)!.label);
    // 5.7 recovery volumes — percent ladder (WinRAR -rv<N%>), not a count list
    await vi.waitFor(() => expect(__quickPicks().length).toBe(6));
    const volumeQp = currentQuickPick(6);
    const volumeLabels = volumeQp.items.map((i) => i.label);
    expect(
      volumeLabels.some((l) => /% of volumes/.test(l)),
      `expected percent options, got: ${volumeLabels.join(", ")}`,
    ).toBe(true);
    await pickLabel(volumeQp, volumeQp.items.find((i) => i.value === 10)!.label);
    // 6. save name
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(3));
    await typeValue(currentInputBox(3), "out");

    await p;
    expect(compressWith7zMock).toHaveBeenCalledTimes(1);
    const options = compressWith7zMock.mock.calls[0][0] as {
      encryptHeaders?: boolean;
      recoveryPercent?: number;
      recoveryVolumeCount?: number;
      recoveryVolumesPercent?: number;
      volumeSize?: string;
    };
    expect(options.encryptHeaders).toBe(true);
    expect(options.recoveryVolumesPercent).toBe(10);
    expect(options.recoveryVolumeCount).toBe(0);
    expect(options.recoveryPercent).toBe(5);
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
    await pickLabel(
      currentQuickPick(4),
      currentQuickPick(4).items.find((i) => i.value === false)!.label,
    );
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

  it("non-split RAR offers a custom recovery-record percentage", async () => {
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
    await pickLabel(
      currentQuickPick(4),
      currentQuickPick(4).items.find((i) => i.value === false)!.label,
    );
    // recovery record — custom percentage
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    const recordQp = currentQuickPick(5);
    const custom = recordQp.items.find((i) => i.value === -1);
    expect(custom, "custom percentage option missing").toBeTruthy();
    await pickLabel(recordQp, custom!.label);
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
    await typeValue(currentInputBox(1), "7");

    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as { recoveryPercent?: number };
    expect(options.recoveryPercent).toBe(7);
  });

  /** Drive the wizard to the recovery-volume step: split RAR, no encryption. */
  async function driveToSplitRecoveryVolumes(volumeValue: string): Promise<Qp> {
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(
      currentQuickPick(3),
      currentQuickPick(3).items[currentQuickPick(3).items.length - 1].label,
    );
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
    await typeValue(currentInputBox(1), volumeValue);
    // encryption — no
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(
      currentQuickPick(4),
      currentQuickPick(4).items.find((i) => i.value === false)!.label,
    );
    // inline recovery record — none
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    await pickLabel(
      currentQuickPick(5),
      currentQuickPick(5).items.find((i) => i.value === 0)!.label,
    );
    // .rev step
    await vi.waitFor(() => expect(__quickPicks().length).toBe(6));
    return currentQuickPick(6);
  }

  it("split RAR recovery volumes use a percent ladder, not a 1..N count list", async () => {
    const uri = vscode.Uri.file(dir);
    const p = compressCommand(uri, []);
    // "1k" volumes → data.bin (50000 B) estimates to ≈49 volumes
    const volumeQp = await driveToSplitRecoveryVolumes("1k");
    const labels = volumeQp.items.map((i) => i.label);
    expect(volumeQp.placeholder ?? "", "prompt shows the estimated volume count").toMatch(
      /about 49 data volumes/,
    );
    expect(
      labels.filter((l) => /% of volumes/.test(l)),
      `expected 4 percent rows, got: ${labels.join(", ")}`,
    ).toHaveLength(4);
    expect(
      labels.some((l) => /Custom percentage/.test(l)),
      "custom percent entry",
    ).toBe(true);
    expect(
      labels.some((l) => /Custom count/.test(l)),
      "custom count entry",
    ).toBe(true);
    expect(
      labels.some((l) => /recommended/.test(l)),
      "one row is marked recommended",
    ).toBe(true);
    // percent rows preview the count from the estimate: 5% of ≈49 → ceil = 3
    const pct5 = volumeQp.items.find((i) => i.value === 5)!;
    expect(pct5.description ?? "", "percent rows preview the derived count").toMatch(
      /repairs up to 3 lost volume/,
    );
    await pickLabel(volumeQp, pct5.label);
    // save name
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "out");

    await p;
    expect(compressWith7zMock).toHaveBeenCalledTimes(1);
    const options = compressWith7zMock.mock.calls[0][0] as {
      recoveryVolumesPercent?: number;
      recoveryVolumeCount?: number;
      volumeSize?: string;
    };
    expect(options.volumeSize).toBe("1k");
    expect(options.recoveryVolumesPercent).toBe(5);
    expect(options.recoveryVolumeCount).toBe(0);
  });

  it("split RAR recovery volumes accept a custom count", async () => {
    const uri = vscode.Uri.file(dir);
    const p = compressCommand(uri, []);
    const volumeQp = await driveToSplitRecoveryVolumes("1k");
    const customCount = volumeQp.items.find((i) => /Custom count/.test(i.label));
    expect(customCount, "custom count entry missing").toBeTruthy();
    await pickLabel(volumeQp, customCount!.label);
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "4");
    // save name
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(3));
    await typeValue(currentInputBox(3), "out");

    await p;
    const options = compressWith7zMock.mock.calls[0][0] as {
      recoveryVolumeCount?: number;
      recoveryVolumesPercent?: number;
    };
    expect(options.recoveryVolumeCount).toBe(4);
    expect(options.recoveryVolumesPercent).toBe(0);
  });

  it("split RAR recovery volumes accept a custom percentage", async () => {
    const uri = vscode.Uri.file(dir);
    const p = compressCommand(uri, []);
    const volumeQp = await driveToSplitRecoveryVolumes("1k");
    const customPct = volumeQp.items.find((i) => /Custom percentage/.test(i.label));
    expect(customPct, "custom percentage entry missing").toBeTruthy();
    await pickLabel(volumeQp, customPct!.label);
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "7");
    // save name
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(3));
    await typeValue(currentInputBox(3), "out");

    await p;
    const options = compressWith7zMock.mock.calls[0][0] as {
      recoveryVolumesPercent?: number;
      recoveryVolumeCount?: number;
    };
    expect(options.recoveryVolumesPercent).toBe(7);
    expect(options.recoveryVolumeCount).toBe(0);
  });
});
