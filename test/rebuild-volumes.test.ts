/**
 * Rebuild-volumes command tests — Smart Archive VSCode Extension
 *
 * Pins the .rev recovery-volume rebuild flow (WinRAR `rar rc`
 * equivalent): a missing volume of a split RAR5 set is reconstructed
 * from the .rev parity volumes and the rebuilt set still passes 7-Zip.
 * Gated on the rar5 binding (to create the set) and bundled 7zz.
 */

import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { rebuildVolumesCommand } from "../src/commands/rebuildVolumes";
import { verifyArchivePassword } from "../src/providers/webview/handlers/shared";
import { gate } from "./gates";
import { tmpDir } from "./tmp";
import { t } from "../src/i18n";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

function haveGates(): boolean {
  return gate("rar5Binding") && gate("bundled7zz");
}

describe("rebuild volumes command", () => {
  it.runIf(haveGates())("rebuilds a deleted middle volume from .rev files", async () => {
    const td = tmpDir("sat_rebv_");
    try {
      const proj = path.join(td, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "big.bin"), require("crypto").randomBytes(150000));
      const first = path.join(td, "v.part1.rar");
      await compressWithRar5({
        format: RAR5_FORMAT,
        outputPath: first,
        targets: [{ fsPath: proj }],
        password: "",
        level: 3,
        volumeSize: "32k",
        recoveryVolumeCount: 3,
      });
      expect(fs.readdirSync(td).some((n) => /\.part\d+\.rev$/i.test(n))).toBe(true);

      // Delete a middle volume, like an interrupted transfer.
      const vols = fs
        .readdirSync(td)
        .filter((n) => /\.part\d+\.rar$/i.test(n))
        .sort();
      expect(vols.length).toBeGreaterThanOrEqual(3);
      const missing = vols[Math.floor(vols.length / 2)];
      fs.rmSync(path.join(td, missing));
      expect(fs.existsSync(path.join(td, missing))).toBe(false);

      const confirmSpy = vi
        .spyOn(vscode.window, "showWarningMessage")
        .mockResolvedValueOnce(t("rebuildVolumes.rebuild") as never);

      await rebuildVolumesCommand(vscode.Uri.file(first));

      expect(confirmSpy).toHaveBeenCalled();
      expect(fs.existsSync(path.join(td, missing))).toBe(true);
      // The rebuilt set must pass 7-Zip's integrity test.
      expect(await verifyArchivePassword(first, "")).toBe(true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
