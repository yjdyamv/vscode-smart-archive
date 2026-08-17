/**
 * Webview split handler tests — Smart Archiver VSCode Extension
 *
 * Pins the split flow: volume-size + RAR5 recovery-volume prompts are
 * driven through the real handler, and the produced split set carries
 * `.rev` recovery volumes that WinRAR/7-Zip conventions require.
 * Gated on the rar5 binding and bundled 7zz.
 */

import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { HandlerState } from "../src/providers/webview/state";
import { handleSplit } from "../src/providers/webview/handlers/split";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { verifyArchivePassword } from "../src/providers/webview/handlers/shared";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

function haveGates(): boolean {
  return gate("rar5Binding") && gate("bundled7zz");
}

describe("webview split handler", () => {
  it.runIf(haveGates())("produces .rev recovery volumes when requested", async () => {
    const td = tmpDir("sat_sprev_");
    try {
      const proj = path.join(td, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "big.bin"), require("crypto").randomBytes(150000));
      const src = path.join(td, "src.rar");
      await compressWithRar5({
        format: RAR5_FORMAT,
        outputPath: src,
        targets: [{ fsPath: proj }],
        password: "",
        level: 3,
      });

      const postMessage = vi.fn();
      const webview = { postMessage } as unknown as vscode.Webview;
      const state: HandlerState = {
        archiveUri: vscode.Uri.file(src),
        archiveName: "src.rar",
        filePath: src,
        password: undefined,
        entries: [],
        entryIndex: new Map(),
        isEncrypted: false,
        cancelSource: null,
      };

      // 1. volume size, 2. recovery volume count
      const qpSpy = vi
        .spyOn(vscode.window, "showQuickPick")
        .mockResolvedValueOnce({ label: "32k", value: "32k" } as never)
        .mockResolvedValueOnce({ label: "2", value: 2 } as never);

      await handleSplit({ webview, state, msg: { c: "split" } });

      expect(qpSpy).toHaveBeenCalledTimes(2);
      const outDir = path.join(td, "src");
      const vols = fs.readdirSync(outDir).filter((n) => /\.part\d+\.rar$/i.test(n));
      const revs = fs.readdirSync(outDir).filter((n) => /\.part\d+\.rev$/i.test(n));
      expect(vols.length).toBeGreaterThanOrEqual(2);
      expect(revs.length).toBeGreaterThanOrEqual(1);
      // The split set (with recovery volumes) must pass 7-Zip integrity.
      expect(await verifyArchivePassword(path.join(outDir, "src.part1.rar"), "")).toBe(true);
      // Success toast posted.
      expect(postMessage.mock.calls.map((c) => c[0])).toContainEqual({
        c: "ok",
        t: expect.any(String),
      });
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
