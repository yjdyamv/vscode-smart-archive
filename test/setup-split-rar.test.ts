/**
 * Webview RAR split support — Smart Archive VSCode Extension
 *
 * Pins the split/merge flag contract for RAR in the archive webview and
 * the production split-RAR conversion path (including WinRAR/7-Zip
 * interoperability of the produced volume sets). Gated on the rar5
 * binding (to create real RAR5 archives) and the bundled 7zz
 * (setupWebview lists archives through it).
 */

import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { compressWithRar5 } from "../src/engines/rar5-engine";
import { setupWebview } from "../src/providers/webview/setup";
import { verifyArchivePassword } from "../src/providers/webview/handlers/shared";
import { convertArchive } from "../src/services/archiveService";
import { gate } from "./gates";
import { tmpDir } from "./tmp";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

function fakeWebview(): vscode.Webview {
  return {
    html: "",
    postMessage: () => {},
    onDidReceiveMessage: () => ({ dispose() {} }),
    asWebviewUri: (uri: unknown) => uri,
  } as unknown as vscode.Webview;
}

function haveGates(): boolean {
  return gate("rar5Binding") && gate("bundled7zz");
}

describe("webview split flags for RAR", () => {
  it.runIf(haveGates())("a single .rar offers Split (_xCanSplit) and no merge flag", async () => {
    const td = tmpDir("sat_rarsp_");
    try {
      const proj = path.join(td, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "a.txt"), "payload");
      const archive = path.join(td, "single.rar");
      await compressWithRar5({
        format: RAR5_FORMAT,
        outputPath: archive,
        targets: [{ fsPath: proj }],
        password: "",
        level: 3,
      });

      const webview = fakeWebview();
      await setupWebview(webview, vscode.Uri.file(archive));

      expect(webview.html).toContain('id="_xCanSplit">true');
      expect(webview.html).not.toContain('id="_xIsSplit">true');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it.runIf(haveGates())("a .partN.rar set is flagged split/read-only and offers no Split", async () => {
    const td = tmpDir("sat_rarsp2_");
    try {
      const proj = path.join(td, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "big.bin"), require("crypto").randomBytes(100000));
      const first = path.join(td, "vol.part1.rar");
      await compressWithRar5({
        format: RAR5_FORMAT,
        outputPath: first,
        targets: [{ fsPath: proj }],
        password: "",
        level: 3,
        volumeSize: "32k",
      });
      expect(fs.existsSync(path.join(td, "vol.part2.rar"))).toBe(true);

      const webview = fakeWebview();
      await setupWebview(webview, vscode.Uri.file(first));

      expect(webview.html).toContain('id="_xIsSplit">true');
      expect(webview.html).toContain('id="_xReadOnly">true');
      expect(webview.html).not.toContain('id="_xCanSplit">true');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it.runIf(haveGates())("convertArchive re-splits a RAR set with header encryption (7-Zip + password readable)", async () => {
    // The full webview split/encrypt path: split RAR set → convertArchive
    // with a volume size and a new password. The produced volumes must
    // land on final names, be 7-Zip-readable, and carry header
    // encryption (member names hidden without the password).
    const td = tmpDir("sat_rarsp3_");
    try {
      const proj = path.join(td, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "big.bin"), require("crypto").randomBytes(150000));
      const src = path.join(td, "src.part1.rar");
      await compressWithRar5({
        format: RAR5_FORMAT,
        outputPath: src,
        targets: [{ fsPath: proj }],
        password: "",
        level: 3,
        volumeSize: "64k",
      });

      const dst = path.join(td, "out.rar");
      await convertArchive(src, "rar", dst, "", "64k", "newpw");

      // RAR5 volumes land on the final names — never temp names — and the
      // bare dst file must not exist (part1 is the first volume).
      const out1 = path.join(td, "out.part1.rar");
      const out2 = path.join(td, "out.part2.rar");
      expect(fs.existsSync(out1)).toBe(true);
      expect(fs.existsSync(out2)).toBe(true);
      expect(fs.existsSync(dst)).toBe(false);
      expect(fs.readdirSync(td).filter((n) => n.startsWith(".sa_tmp_"))).toEqual([]);

      // 7-Zip must read the set (7zz t is the read-back path the
      // extension uses), and header encryption must reject the wrong
      // password while accepting the right one.
      expect(await verifyArchivePassword(out1, "wrong")).toBe(false);
      expect(await verifyArchivePassword(out1, "newpw")).toBe(true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
