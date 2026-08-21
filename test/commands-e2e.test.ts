/**
 * Command end-to-end tests — Smart Archiver
 *
 * Drives the real command layer (compress / decompress / repair) through
 * the full seam: wizard UI on the scriptable vscode test double → real
 * engine dispatchers → in-process archive core → real WASM/binding. No
 * engine mocking here — the produced archives are verified with the
 * independent fixture oracle (raw 7zz CLI) or the bundled 7zz binary.
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import * as vscode from "vscode";
import { __quickPicks, __setSaveDialogResult, __setOpenDialogResult, __setConfig, __dialogs } from "./__mocks__/vscode";

import { j7zDecompress, j7zCompressDir } from "./helpers";
import { gate } from "./gates";
import { compressCommand } from "../src/commands/compress";
import { decompressCommand, decompressToCommand } from "../src/commands/decompress";
import { repairCommand } from "../src/commands/repair";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { bundled7zPath } from "../src/engines/bundled7z";
import { tmpDir } from "./tmp";

interface Qp {
  items: { label: string; value?: unknown }[];
  accept: (item?: { label: string; value?: unknown }) => void;
}
function qp(nth: number): Qp {
  const pick = __quickPicks()[nth - 1] as unknown as Qp;
  expect(pick, `quick pick #${nth} not created`).toBeTruthy();
  return pick;
}

async function pickItem(p: Qp, item: { label: string; value?: unknown }): Promise<void> {
  p.accept(item);
  await Promise.resolve();
  await Promise.resolve();
}

async function pickByLabel(p: Qp, label: string): Promise<void> {
  const item = p.items.find((i) => i.label === label);
  expect(item, `option "${label}" not offered (got: ${p.items.map((i) => i.label).join(", ")})`).toBeTruthy();
  await pickItem(p, item!);
}

describe("compress command (real engine)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("sat_cmde2e-");
    fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.txt"), "hello command");
    fs.writeFileSync(path.join(dir, "src", "deep", "b.txt"), "nested world");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("compresses a folder through the wizard with the real engine", async () => {
    const outArchive = path.join(dir, "out.7z");
    __setSaveDialogResult(vscode.Uri.file(outArchive));

    const p = compressCommand(vscode.Uri.file(path.join(dir, "src")), []);
    await vi.waitFor(() => expect(__quickPicks().length).toBe(1));
    await pickByLabel(qp(1), "7z");
    await vi.waitFor(() => expect(__quickPicks().length).toBe(2));
    await pickItem(qp(2), qp(2).items[0]); // level — default
    await vi.waitFor(() => expect(__quickPicks().length).toBe(3));
    await pickItem(qp(3), qp(3).items[0]); // volume — don't split
    await vi.waitFor(() => expect(__quickPicks().length).toBe(4));
    await pickItem(qp(4), qp(4).items.find((i) => i.value === false)!); // encryption — no

    await p;
    expect(fs.existsSync(outArchive)).toBe(true);

    const extracted = await j7zDecompress(fs.readFileSync(outArchive));
    expect(extracted["src/a.txt"]).toBe("hello command");
    expect(extracted["src/deep/b.txt"]).toBe("nested world");
  });
});

describe("decompress command (real engine)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("sat_cmde2e-");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("extracts an archive to <name>.extracted through the command", async () => {
    const buf = await j7zCompressDir(
      { "/a.txt": "decompress me", "/sub/c.txt": "deep" },
      "/x.7z",
    );
    const archive = path.join(dir, "input.7z");
    fs.writeFileSync(archive, buf);

    await decompressCommand(vscode.Uri.file(archive), undefined);

    const outDir = path.join(dir, "input.extracted");
    expect(fs.readFileSync(path.join(outDir, "a.txt"), "utf8")).toBe("decompress me");
    expect(fs.readFileSync(path.join(outDir, "sub", "c.txt"), "utf8")).toBe("deep");
  });

  it("extracts an archive into a user-chosen folder via extract-to", async () => {
    const buf = await j7zCompressDir(
      { "/a.txt": "to chosen folder", "/sub/c.txt": "deep chosen" },
      "/x.7z",
    );
    const archive = path.join(dir, "input.7z");
    fs.writeFileSync(archive, buf);

    const destDir = path.join(dir, "chosen");
    __setConfig("smart-archiver", "extractTo.enabled", true);
    __setOpenDialogResult([vscode.Uri.file(destDir)]);
    await decompressToCommand(vscode.Uri.file(archive), undefined);

    expect(fs.readFileSync(path.join(destDir, "a.txt"), "utf8")).toBe("to chosen folder");
    expect(fs.readFileSync(path.join(destDir, "sub", "c.txt"), "utf8")).toBe("deep chosen");
    expect(fs.existsSync(path.join(dir, "input.extracted"))).toBe(false);
  });

  it("refuses to run extract-to while the setting is off", async () => {
    const buf = await j7zCompressDir({ "/a.txt": "nope" }, "/x.7z");
    const archive = path.join(dir, "input.7z");
    fs.writeFileSync(archive, buf);

    __setConfig("smart-archiver", "extractTo.enabled", false);
    __setOpenDialogResult([vscode.Uri.file(path.join(dir, "chosen"))]);
    await decompressToCommand(vscode.Uri.file(archive), undefined);

    const infos = __dialogs().filter((d) => d.kind === "information");
    expect(infos.some((d) => d.message.includes("disabled"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "chosen"))).toBe(false);
  });

  it("asks before overwriting existing files in the chosen folder", async () => {
    const buf = await j7zCompressDir({ "/a.txt": "new content" }, "/x.7z");
    const archive = path.join(dir, "input.7z");
    fs.writeFileSync(archive, buf);

    const destDir = path.join(dir, "chosen");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "a.txt"), "precious data");

    __setConfig("smart-archiver", "extractTo.enabled", true);
    __setOpenDialogResult([vscode.Uri.file(destDir)]);
    // The dialog mock resolves undefined (no confirmation) → extraction aborts.
    await decompressToCommand(vscode.Uri.file(archive), undefined);

    const warnings = __dialogs().filter((d) => d.kind === "warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0].message).toContain("1");
    // The existing file is untouched.
    expect(fs.readFileSync(path.join(destDir, "a.txt"), "utf8")).toBe("precious data");
  });
});

describe("repair command (real engine)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("sat_cmde2e-");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.runIf(gate("rar5Binding") && gate("bundled7zz"))(
    "repairs a damaged RAR5 archive via its recovery record",
    async () => {
      const proj = path.join(dir, "proj");
      fs.mkdirSync(proj, { recursive: true });
      // Incompressible payload large enough that a mid-file byte flip lands
      // inside the data block, not the trailing recovery-record region.
      const payload = require("crypto").randomBytes(300_000);
      fs.writeFileSync(path.join(proj, "big.bin"), payload);

      const archive = path.join(dir, "damaged.rar");
      await compressWithRar5(
        {
          format: { label: "rar", description: "rar", canCreate: true, supportsEncryption: true },
          outputPath: archive,
          targets: [{ fsPath: proj }],
          password: "",
          recoveryPercent: 5,
          level: 3,
        },
        undefined,
        undefined,
        [],
      );
      expect(fs.existsSync(archive)).toBe(true);

      // Corrupt a byte inside the payload region.
      const raw = fs.readFileSync(archive);
      const at = Math.floor(raw.length * 0.6);
      raw[at] = raw[at] ^ 0xff;
      fs.writeFileSync(archive, raw);

      let damagedStillOk = true;
      try {
        childProcess.execFileSync(bundled7zPath()!, ["t", archive], { encoding: "utf8" });
      } catch {
        damagedStillOk = false;
      }
      expect(damagedStillOk, "corruption must make 7zz test fail").toBe(false);

      await repairCommand(vscode.Uri.file(archive));

      const repaired = archive.replace(/\.rar$/, "_repaired.rar");
      expect(fs.existsSync(repaired)).toBe(true);
      const testOut = childProcess.execFileSync(bundled7zPath()!, ["t", repaired], {
        encoding: "utf8",
      });
      expect(testOut).toContain("Everything is Ok");
    },
  );
});
