/**
 * Encrypted-archive webview setup tests — Smart Archive VSCode Extension
 *
 * Pins the vault-unlock flow in setupWebview: an encrypted archive whose
 * password is in the session vault opens directly (no password view) and
 * renders _xIsEncrypted — the StatusBar must show Decrypt, not Encrypt.
 * Regression: the password-retry success path cleared isEnc, so re-opened
 * encrypted archives (vault or state password) looked unencrypted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { setupWebview } from "../src/providers/webview/setup";
import {
  disposePasswordVault,
  getCachedArchivePassword,
  initPasswordVault,
  saveArchivePassword,
} from "../src/providers/passwordVault";
import { j7zCompress } from "./helpers";
import { tmpDir } from "./tmp";

function fakeSecretStorage() {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      store: async (k: string, v: string) => {
        store.set(k, v);
      },
      get: async (k: string) => store.get(k),
      delete: async (k: string) => {
        store.delete(k);
      },
    },
  };
}

function fakeWebview() {
  return {
    html: "",
    postMessage: () => {},
    onDidReceiveMessage: () => ({ dispose() {} }),
    asWebviewUri: (uri: unknown) => uri,
  };
}

async function buildEncryptedArchive(dir: string): Promise<string> {
  const buf = await j7zCompress({ "/s.txt": "sec" }, "/e.7z", ["-ppw", "-mhe=on"]);
  const arc = path.join(dir, "e.7z");
  fs.writeFileSync(arc, Buffer.from(buf));
  return arc;
}

describe("setupWebview with a vaulted password", () => {
  beforeEach(() => {
    initPasswordVault(fakeSecretStorage().api);
  });

  afterEach(async () => {
    await disposePasswordVault();
  });

  it("opens an encrypted archive directly and renders _xIsEncrypted (Decrypt)", async () => {
    const td = tmpDir("sat_encpv_");
    try {
      const arc = await buildEncryptedArchive(td);
      await saveArchivePassword(arc, "pw");

      const webview = fakeWebview() as unknown as vscode.Webview;
      await setupWebview(webview, vscode.Uri.file(arc));

      // Opened without a password prompt and flagged as encrypted.
      expect(webview.html).not.toContain('id="_xViewState">"password"');
      expect(webview.html).toContain('id="_xIsEncrypted">true');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it("still shows the password view when no vaulted password exists", async () => {
    const td = tmpDir("sat_encpv2_");
    try {
      const arc = await buildEncryptedArchive(td);
      const webview = fakeWebview() as unknown as vscode.Webview;
      await setupWebview(webview, vscode.Uri.file(arc));

      expect(webview.html).toContain('id="_xViewState">"password"');
      expect(webview.html).not.toContain('id="_xIsEncrypted">true');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it("a stale vault from a previous session does not unlock the archive", async () => {
    const td = tmpDir("sat_encpv3_");
    try {
      const arc = await buildEncryptedArchive(td);
      // Previous session stored the password; a new session starts fresh.
      await saveArchivePassword(arc, "pw");
      await disposePasswordVault();
      initPasswordVault(fakeSecretStorage().api);

      expect(await getCachedArchivePassword(arc)).toBeUndefined();
      const webview = fakeWebview() as unknown as vscode.Webview;
      await setupWebview(webview, vscode.Uri.file(arc));
      expect(webview.html).toContain('id="_xViewState">"password"');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
