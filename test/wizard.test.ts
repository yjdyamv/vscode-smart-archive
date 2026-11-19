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
 *
 * Interaction contract under test: every parameter step is a free-text
 * picker. Typed text that parses wins over the highlighted row, an empty field
 * takes the highlighted (first = default) row, unparseable text keeps the
 * picker open instead of cancelling, and no "Custom…" row exists anywhere.
 */
import * as fs from "fs";
import * as path from "path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { __quickPicks, __inputBoxes, __dialogs, __setSaveDialogResult } from "./__mocks__/vscode";

vi.mock("../src/engines/js7z-compress", () => ({
  compressWith7z: vi.fn(async () => {}),
}));

import { compressCommand } from "../src/commands/compress";
import { togglePasswordVisible } from "../src/ui/prompts";
import { compressWith7z } from "../src/engines/js7z-compress";
import { tmpDir } from "./tmp";

const compressWith7zMock = vi.mocked(compressWith7z);

interface QpItem {
  label: string;
  value?: unknown;
  description?: string;
}
interface Qp {
  items: QpItem[];
  value: string;
  type: (text: string) => void;
  hide: () => void;
  accept: (item?: QpItem) => void;
}
interface Ib {
  value: string;
  password: boolean;
  buttons: unknown[];
  accept: (value?: string) => void;
  triggerButton: (button: unknown) => void;
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

/** Type into the picker's filter field, then press Enter. */
async function typeAndEnter(qp: Qp, text: string, highlighted?: QpItem): Promise<void> {
  qp.type(text);
  await Promise.resolve();
  qp.accept(highlighted);
  await Promise.resolve();
  await Promise.resolve();
}

async function typeValue(ib: Ib, value: string): Promise<void> {
  ib.accept(value);
  await Promise.resolve();
  await Promise.resolve();
}

/** The input box currently on screen, once the wizard opens one. */
async function openInputBox(): Promise<Ib> {
  let box: Ib | undefined;
  await vi.waitFor(() => {
    const open = (__inputBoxes() as unknown as (Ib & { hiddenState: boolean })[]).filter(
      (b) => !b.hiddenState,
    );
    box = open.at(-1);
    expect(box, "no open input box").toBeTruthy();
  });
  return box!;
}

/**
 * Encryption is a password box, not a yes/no menu: a blank Enter skips it, and
 * a real password is asked twice. Both answers go to whichever box is actually
 * open — the wizard may have opened it before the test got here.
 */
async function setPassword(password: string): Promise<void> {
  await typeValue(await openInputBox(), password);
  if (password.length === 0) return;
  await typeValue(await openInputBox(), password);
}

const noCustomRows = (qp: Qp): void => {
  expect(
    qp.items.map((i) => i.label).filter((l) => /Custom/i.test(l)),
    "no Custom… row: the field itself is the custom input",
  ).toEqual([]);
};

/** The `.rev` step offers exact counts, so rows carry the count itself. */
function revCountRow(qp: Qp, count: number): QpItem {
  const item = qp.items.find((i) => i.value === count);
  expect(item, `${count} recovery-volume row missing`).toBeTruthy();
  return item!;
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

  it("encryption forces header encryption; a typed volume size, then the record and .rev ladders", async () => {
    const uri = vscode.Uri.file(dir);

    const p = compressCommand(uri, []).catch((e) => {
      process.stdout.write("CMD-ERR: " + (e instanceof Error ? e.message : String(e)) + "\n");
      throw e;
    });
    // 1. format
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    // 2. level — Enter on the highlighted (default) row
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    // 3. volume — typed 32k, no "Custom…" row to select first
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    const volumeQp = currentQuickPick(3);
    noCustomRows(volumeQp);
    expect(volumeQp.items[0].label, "empty Enter = don't split").toMatch(/Don't split/);
    await typeAndEnter(volumeQp, "32k");
    // 4. password — the step *is* the box, asked twice because a typo here is
    // unrecoverable; a real password also forces RAR header encryption
    await setPassword("pw");
    // 4.5 inline recovery record — split RAR offers the per-volume percent
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    const recordQp = currentQuickPick(4);
    const recordLabels = recordQp.items.map((i) => i.label);
    expect(
      recordLabels.some((l) => /of each volume/.test(l)),
      `expected per-volume percent, got: ${recordLabels.join(", ")}`,
    ).toBe(true);
    noCustomRows(recordQp);
    await pickLabel(recordQp, recordQp.items.find((i) => i.value === 5)!.label);
    // 4.6 recovery volumes — counts only, capped by the data-volume count
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    const volumeRevQp = currentQuickPick(5);
    const volumeLabels = volumeRevQp.items.map((i) => i.label);
    expect(
      volumeLabels.some((l) => /%/.test(l)),
      `no percent row any more, got: ${volumeLabels.join(", ")}`,
    ).toBe(false);
    noCustomRows(volumeRevQp);
    // 50 KB of data in 32 KiB volumes ≈ 2 data volumes → 2 is the ceiling
    expect(volumeLabels).toHaveLength(3);
    await pickLabel(volumeRevQp, revCountRow(volumeRevQp, 1).label);
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
    expect(options.recoveryVolumeCount).toBe(1);
    expect(options.recoveryVolumesPercent).toBeUndefined();
    expect(options.recoveryPercent).toBe(5);
    expect(options.volumeSize).toBe("32k");
  });

  it("the password is asked twice, and a mismatch starts the step over", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label);
    // Step 4 opens the password box directly — no "encrypt?" question first.
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
    // first box: the password
    await typeValue(currentInputBox(1), "hunter2");
    // second box: a different password → nothing is accepted
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "hunter3");
    expect(
      __dialogs().some((d) => d.kind === "warning" && /don't match/.test(d.message)),
      "the mismatch is reported, not swallowed",
    ).toBe(true);
    // the step restarts at the first box rather than keeping either value
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(3));
    await typeValue(currentInputBox(3), "hunter2");
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(4));
    await typeValue(currentInputBox(4), "hunter2");
    // then on to the recovery record
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(currentQuickPick(4), currentQuickPick(4).items[0].label);
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    expect((compressWith7zMock.mock.calls[0][0] as { password?: string }).password).toBe("hunter2");
  });

  it("a bare Enter on the password box means no encryption, and asks nothing more", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label);
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
    await typeValue(currentInputBox(1), "");
    // No confirmation box: there is nothing to mistype.
    expect(__inputBoxes().length, "a blank password is not asked twice").toBe(1);
    // ...and the flow moves straight on to the recovery record.
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(currentQuickPick(4), currentQuickPick(4).items[0].label);
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as {
      password?: string;
      encryptHeaders?: boolean;
    };
    // An empty password is how this layer spells "no encryption".
    expect(options.password).toBe("");
    expect(options.encryptHeaders).toBe(false);
  });

  it("Ctrl+H shows and re-hides the password, and the eye button does the same", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label);
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
    const box = currentInputBox(1);
    expect(box.password, "the password starts masked").toBe(true);

    // Ctrl+H arrives as a command — a QuickInput has no key events of its own.
    togglePasswordVisible();
    expect(box.password, "Ctrl+H reveals the password").toBe(false);
    togglePasswordVisible();
    expect(box.password, "Ctrl+H masks it again").toBe(true);

    // The eye is the mouse path to the same toggle, and it swaps its own icon.
    box.triggerButton(box.buttons[0]);
    expect(box.password, "the eye reveals the password").toBe(false);

    await typeValue(box, "");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(currentQuickPick(4), currentQuickPick(4).items[0].label);
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    // Once the box is gone the shortcut is a no-op instead of targeting a dead box.
    expect(() => togglePasswordVisible()).not.toThrow();
  });

  it("the shortcut is contributed inside quick inputs, and hidden from the palette", async () => {
    const pkg = (await import("../package.json")) as unknown as {
      contributes: {
        keybindings?: { command: string; key: string; when?: string }[];
        menus: { commandPalette: { command: string; when?: string }[] };
      };
    };
    const binding = pkg.contributes.keybindings?.find(
      (k) => k.command === "yjdyamv.smart-archiver.togglePasswordVisibility",
    );
    expect(binding?.key, "Ctrl+H is what the tooltip promises").toBe("ctrl+h");
    expect(binding?.when, "only while a quick input has focus").toBe("inQuickInput");
    expect(
      pkg.contributes.menus.commandPalette.some(
        (m) => m.command === "yjdyamv.smart-archiver.togglePasswordVisibility",
      ),
      "an internal toggle does not belong in the palette",
    ).toBe(true);
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
    // no encryption: the password box *is* the step, a blank Enter skips it
    await setPassword("");
    // recovery record — percent options
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    const recoveryQp = currentQuickPick(4);
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

  /** Drive to the non-split recovery-record step: RAR, no split, no encryption. */
  async function driveToRecordStep(): Promise<Qp> {
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label);
    await setPassword("");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    return currentQuickPick(4);
  }

  it("non-split RAR accepts a typed recovery-record percentage", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    const recordQp = await driveToRecordStep();
    // Typed text wins over whatever row is highlighted — no "Custom…" detour.
    await typeAndEnter(recordQp, "7", recordQp.items[1]);

    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as { recoveryPercent?: number };
    expect(options.recoveryPercent).toBe(7);
  });

  it("an empty Enter takes no recovery record", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    const recordQp = await driveToRecordStep();
    expect(recordQp.items[0].label, "first row is the default").toMatch(/No recovery record/i);
    await pickLabel(recordQp, recordQp.items[0].label);

    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as { recoveryPercent?: number };
    expect(options.recoveryPercent).toBe(0);
  });

  // Sloppy but real: an IME left in full-width mode, a space before the %,
  // a comma decimal, "ten percent" written as a word.
  const typedPercents: [typed: string, expected: number][] = [
    ["７", 7],
    ["５％", 5],
    [" 5 % ", 5],
    ["0", 0],
    ["100", 100],
    ["10%", 10],
  ];
  for (const [typed, expected] of typedPercents) {
    it(`recovery record accepts ${JSON.stringify(typed)} as ${expected}%`, async () => {
      const p = compressCommand(vscode.Uri.file(dir), []);
      const recordQp = await driveToRecordStep();
      await typeAndEnter(recordQp, typed);
      await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
      await p;
      expect(
        (compressWith7zMock.mock.calls[0][0] as { recoveryPercent?: number }).recoveryPercent,
      ).toBe(expected);
    });
  }

  for (const typed of ["101", "-3", "5.5", "%", "abc", "一"]) {
    it(`recovery record rejects ${JSON.stringify(typed)} instead of using a fallback`, async () => {
      const p = compressCommand(vscode.Uri.file(dir), []);
      const recordQp = await driveToRecordStep();
      await typeAndEnter(recordQp, typed);
      expect(__quickPicks().length, "still on the record step").toBe(4);
      expect(compressWith7zMock).not.toHaveBeenCalled();
      expect(recordQp.items[0].label).toContain(typed);
      expect(recordQp.items[0].label).toMatch(/not a percentage/i);
      await typeAndEnter(recordQp, "3");
      await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
      await p;
      expect(
        (compressWith7zMock.mock.calls[0][0] as { recoveryPercent?: number }).recoveryPercent,
      ).toBe(3);
    });
  }

  it("unparseable text keeps the picker open instead of cancelling or accepting", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    const recordQp = await driveToRecordStep();
    await typeAndEnter(recordQp, "abc");
    // Still the same step, nothing ran: the pinned row explains the input.
    expect(__quickPicks().length, "no next step opened").toBe(4);
    expect(compressWith7zMock).not.toHaveBeenCalled();
    expect(recordQp.items[0].label, "pinned row names the rejected text").toMatch(/abc/);
    // ...and a valid entry still completes the step.
    await typeAndEnter(recordQp, "3");
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as { recoveryPercent?: number };
    expect(options.recoveryPercent).toBe(3);
  });

  it("a volume size needs a unit — a bare number is not silently accepted", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    const volumeQp = currentQuickPick(3);
    await typeAndEnter(volumeQp, "100");
    expect(__quickPicks().length, "still on the volume step").toBe(3);
    await typeAndEnter(volumeQp, "100m");
    // volumeSize "100m" means split → password (blank), record, .rev, save name
    await setPassword("");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(currentQuickPick(4), currentQuickPick(4).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    await pickLabel(currentQuickPick(5), currentQuickPick(5).items[0].label);
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "out");
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as { volumeSize?: string };
    expect(options.volumeSize).toBe("100m");
  });

  /** Drive the wizard to the recovery-volume step: split RAR, no encryption. */
  async function driveToSplitRecoveryVolumes(volumeValue: string): Promise<Qp> {
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "rar");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await typeAndEnter(currentQuickPick(3), volumeValue);
    // no encryption: blank Enter on the password box
    await setPassword("");
    // inline recovery record — none
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickLabel(
      currentQuickPick(4),
      currentQuickPick(4).items.find((i) => i.value === 0)!.label,
    );
    // .rev step
    await vi.waitFor(() => expect(__quickPicks().length).toBe(5));
    return currentQuickPick(5);
  }

  it("split RAR recovery volumes are counts, capped by the data-volume count", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    // "1k" volumes → data.bin (50000 B) estimates to ≈49 volumes
    const volumeQp = await driveToSplitRecoveryVolumes("1k");
    const labels = volumeQp.items.map((i) => i.label);
    expect(volumeQp.placeholder ?? "", "prompt shows the estimated volume count").toMatch(
      /about 49 data volumes/,
    );
    expect(
      labels.filter((l) => /%/.test(l)),
      "no percent rows",
    ).toEqual([]);
    noCustomRows(volumeQp);
    // none + 1, 2, 3, 5, 10 — all below the 49-data-volume ceiling
    expect(labels).toHaveLength(6);
    // The ladder carries no "recommended" badge: the ceiling already bounds the
    // choice, and a badge on top of it is a third hint nobody asked for.
    expect(
      labels.filter((l) => /recommended/.test(l)),
      "no recommended badge on the counts",
    ).toEqual([]);
    const three = volumeQp.items.find((i) => i.label.startsWith("3 recovery volume"))!;
    expect(three.description ?? "", "the row previews what it repairs").toMatch(
      /repairs up to 3 lost volume/,
    );
    // 1000 .rev volumes cannot protect 49 data volumes — clamped, and said so
    volumeQp.type("1000");
    await Promise.resolve();
    expect(volumeQp.items[0].label, "pinned row reports the clamp").toMatch(/capped at the 49/);
    volumeQp.accept();
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "out");
    await p;
    expect(compressWith7zMock).toHaveBeenCalledTimes(1);
    const options = compressWith7zMock.mock.calls[0][0] as {
      recoveryVolumeCount?: number;
      recoveryVolumesPercent?: number;
      volumeSize?: string;
    };
    expect(options.volumeSize).toBe("1k");
    expect(options.recoveryVolumeCount).toBe(49);
    expect(options.recoveryVolumesPercent).toBeUndefined();
  });

  it("split RAR recovery volumes accept a typed exact count", async () => {
    const uri = vscode.Uri.file(dir);
    const p = compressCommand(uri, []);
    const volumeQp = await driveToSplitRecoveryVolumes("1k");
    await typeAndEnter(volumeQp, "4");
    // save name
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "out");

    await p;
    const options = compressWith7zMock.mock.calls[0][0] as {
      recoveryVolumeCount?: number;
      recoveryVolumesPercent?: number;
    };
    expect(options.recoveryVolumeCount).toBe(4);
    expect(options.recoveryVolumesPercent).toBeUndefined();
  });

  it("a typed percentage is refused — the .rev step takes a count now", async () => {
    const uri = vscode.Uri.file(dir);
    const p = compressCommand(uri, []);
    const volumeQp = await driveToSplitRecoveryVolumes("1k");
    await typeAndEnter(volumeQp, "7%");
    expect(__inputBoxes().length, "only the password box exists so far").toBe(1);
    expect(volumeQp.items[0].label).toContain("7%");
    expect(volumeQp.items[0].label).toMatch(/not a recovery-volume count/i);
    await typeAndEnter(volumeQp, "7");
    // save name
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "out");

    await p;
    const options = compressWith7zMock.mock.calls[0][0] as {
      recoveryVolumeCount?: number;
      recoveryVolumesPercent?: number;
    };
    expect(options.recoveryVolumeCount).toBe(7);
    expect(options.recoveryVolumesPercent).toBeUndefined();
  });
  // The .rev field is a count now, so real typing only has to survive
  // full-width digits and stray spaces — no percentage to disambiguate.
  const typedRev: [typed: string, count: number][] = [
    ["４", 4],
    ["12", 12],
    [" 6 ", 6],
    ["0", 0],
  ];
  for (const [typed, count] of typedRev) {
    it(`.rev accepts ${JSON.stringify(typed)} → ${count} recovery volume(s)`, async () => {
      const p = compressCommand(vscode.Uri.file(dir), []);
      const volumeQp = await driveToSplitRecoveryVolumes("1k");
      await typeAndEnter(volumeQp, typed);
      await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
      await typeValue(currentInputBox(2), "out");
      await p;
      expect(compressWith7zMock).toHaveBeenCalledTimes(1);
      const options = compressWith7zMock.mock.calls[0][0] as {
        recoveryVolumeCount?: number;
        recoveryVolumesPercent?: number;
      };
      expect(options.recoveryVolumeCount).toBe(count);
      expect(options.recoveryVolumesPercent).toBeUndefined();
    });
  }

  for (const typed of ["abc", "%", "四", "4.5", "-1"]) {
    it(`.rev rejects ${JSON.stringify(typed)} and asks for a count`, async () => {
      const p = compressCommand(vscode.Uri.file(dir), []);
      const volumeQp = await driveToSplitRecoveryVolumes("1k");
      await typeAndEnter(volumeQp, typed);
      expect(__inputBoxes().length, "only the password box exists so far").toBe(1);
      expect(volumeQp.items[0].label).toContain(typed);
      expect(volumeQp.items[0].label).toMatch(/not a recovery-volume count/i);
      await typeAndEnter(volumeQp, "2");
      await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
      await typeValue(currentInputBox(2), "out");
      await p;
      expect(
        (compressWith7zMock.mock.calls[0][0] as { recoveryVolumeCount?: number })
          .recoveryVolumeCount,
      ).toBe(2);
    });
  }
});

describe("compress wizard (level and volume typing, non-RAR)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("sat_wiz-");
    fs.writeFileSync(path.join(dir, "data.bin"), require("crypto").randomBytes(50000));
    __setSaveDialogResult(vscode.Uri.file("/tmp/out.zip"));
    compressWith7zMock.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a typed level outside the preset ladder (2/4/6/8) is honoured", async () => {
    const p = compressCommand(vscode.Uri.file(dir), []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "zip");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    const levelQp = currentQuickPick(2);
    // Presets are 0/1/3/5/7/9 — 4 is reachable only by typing.
    expect(levelQp.items.map((i) => i.value)).not.toContain(4);
    await typeAndEnter(levelQp, "4");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label);
    await setPassword("");
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as { level?: number };
    expect(options.level).toBe(4);
  });
});

/**
 * What people actually type.
 *
 * The picker's field accepts free text, so the parsers have to survive real
 * input: a Chinese IME in full-width mode, a space between number and unit,
 * "MB" instead of "M", a decimal size like 1.1m, a comma decimal from a
 * numeric keypad, a zero, a stray percent sign. Broken input must say what the
 * field wants instead of silently compressing with a fallback size.
 */
describe("compress wizard (sloppy real-world input)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("sat_wiz-");
    fs.writeFileSync(path.join(dir, "data.bin"), require("crypto").randomBytes(50000));
    __setSaveDialogResult(vscode.Uri.file("/tmp/out.zip"));
    compressWith7zMock.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** zip → level → volume step (3rd picker). */
  async function driveToVolumeStep(): Promise<{ p: Promise<void>; volumeQp: Qp }> {
    const p = compressCommand(vscode.Uri.file(dir), []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickLabel(currentQuickPick(1), "zip");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickLabel(currentQuickPick(2), currentQuickPick(2).items[0].label);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    return { p, volumeQp: currentQuickPick(3) };
  }

  /** Pick no-encryption, name the split set, and return the engine options. */
  async function finishSplit(p: Promise<void>): Promise<{ volumeSize?: string; level?: number }> {
    await setPassword("");
    await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
    await typeValue(currentInputBox(2), "out");
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    return compressWith7zMock.mock.calls[0][0] as { volumeSize?: string; level?: number };
  }

  const acceptedSizes: [typed: string, expected: string][] = [
    ["1.1m", "1.1m"], // the size people actually want; rounding must not mangle it
    ["1.1M", "1.1m"],
    ["100m", "100m"],
    ["100 m", "100m"], // space before the unit
    ["100MB", "100m"], // "MB" is what the OS shows, "M" is what the archiver takes
    ["1.5 GiB", "1.5g"],
    ["700k", "700k"],
    ["2g", "2g"],
    ["100 m ", "100m"], // trailing space
    ["５０Ｍ", "50m"], // full-width digits + full-width letter (IME left on)
    ["０．５ｍ", "0.5m"], // full-width decimal point
  ];

  for (const [typed, expected] of acceptedSizes) {
    it(`accepts ${JSON.stringify(typed)} as ${expected}`, async () => {
      const { p, volumeQp } = await driveToVolumeStep();
      await typeAndEnter(volumeQp, typed);
      const options = await finishSplit(p);
      expect(options.volumeSize).toBe(expected);
    });
  }

  const rejectedSizes: [typed: string, why: string][] = [
    ["100", "no unit — parseSize would silently use the default"],
    ["1,5m", "comma decimal from a numeric keypad"],
    ["1.1.1m", "two decimals"],
    ["0m", "a zero-size volume"],
    ["-5m", "a negative size"],
    ["1e9", "exponent notation"],
    ["5 m g", "two units"],
    ["abc", "not a number at all"],
    ["一兆", "a Chinese numeral"],
    ["1.1", "a size without a unit"],
  ];

  for (const [typed, why] of rejectedSizes) {
    it(`rejects ${JSON.stringify(typed)} (${why}) and says what it wants`, async () => {
      const { p, volumeQp } = await driveToVolumeStep();
      await typeAndEnter(volumeQp, typed);
      expect(__quickPicks().length, "still on the volume step").toBe(3);
      expect(compressWith7zMock).not.toHaveBeenCalled();
      // The pinned row quotes the input and names the expected shape.
      expect(volumeQp.items[0].label).toContain(typed);
      expect(volumeQp.items[0].label).toMatch(/is not a size|not a value/i);
      // A good value still gets through afterwards.
      await typeAndEnter(volumeQp, "10m");
      await finishSplit(p);
    });
  }

  it("the default row on the volume step means don't split", async () => {
    const { p, volumeQp } = await driveToVolumeStep();
    expect(volumeQp.items[0].label).toBe("Don't split");
    // The first row is what an empty Enter takes in a real picker.
    await pickLabel(volumeQp, volumeQp.items[0].label);
    await setPassword("");
    await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
    await p;
    const options = compressWith7zMock.mock.calls[0][0] as { volumeSize?: string };
    expect(options.volumeSize, "no volumes").toBeFalsy();
  });

  it("a typed size means binary MiB, the same unit the engine writes", async () => {
    // "100m" is 100 MiB — exactly the preset's label and exactly what 7z
    // writes; no decimal-media translation in between.
    const { p, volumeQp } = await driveToVolumeStep();
    await typeAndEnter(volumeQp, "100m");
    const options = await finishSplit(p);
    expect(options.volumeSize).toBe("100m");
  });

  it("a bare number is still the size's fault, not the picker's: the hint names the unit", async () => {
    const { p, volumeQp } = await driveToVolumeStep();
    await typeAndEnter(volumeQp, "500");
    expect(volumeQp.items[0].label).toMatch(/100m, 1\.5g, 700k/);
    await typeAndEnter(volumeQp, "500m");
    await finishSplit(p);
  });

  const acceptedLevels: [typed: string, expected: number][] = [
    ["4", 4],
    [" 7 ", 7],
    ["４", 4], // full-width
    ["２", 2],
    ["0", 0], // store — valid, unlike a volume of 0
  ];

  for (const [typed, expected] of acceptedLevels) {
    it(`accepts level ${JSON.stringify(typed)}`, async () => {
      const p = compressCommand(vscode.Uri.file(dir), []);
      await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
      await pickLabel(currentQuickPick(1), "zip");
      await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
      await typeAndEnter(currentQuickPick(2), typed);
      await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
      await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label); // don't split
      await setPassword("");
      await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
      await p;
      const options = compressWith7zMock.mock.calls[0][0] as { level?: number };
      expect(options.level).toBe(expected);
    });
  }

  for (const typed of ["10", "11", "4.", "-1", "nine", "9 9"]) {
    it(`rejects level ${JSON.stringify(typed)} and keeps the picker open`, async () => {
      const p = compressCommand(vscode.Uri.file(dir), []);
      await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
      await pickLabel(currentQuickPick(1), "zip");
      await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
      const levelQp = currentQuickPick(2);
      await typeAndEnter(levelQp, typed);
      expect(__quickPicks().length, "still on the level step").toBe(2);
      expect(levelQp.items[0].label).toContain(typed);
      expect(levelQp.items[0].label).toMatch(/not a level/i);
      await typeAndEnter(levelQp, "5");
      await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
      await pickLabel(currentQuickPick(3), currentQuickPick(3).items[0].label);
      await setPassword("");
      await vi.waitFor(() => expect(compressWith7zMock).toHaveBeenCalledTimes(1));
      await p;
      expect((compressWith7zMock.mock.calls[0][0] as { level?: number }).level).toBe(5);
    });
  }
});
