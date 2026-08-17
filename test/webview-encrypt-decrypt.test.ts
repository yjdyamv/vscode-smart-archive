/**
 * Encrypt/decrypt webview handler tests — Smart Archiver VSCode Extension
 *
 * Pins the status-bar button semantics: encrypt/decrypt write a NEW archive
 * (…_encrypted.ext / …_decrypted.ext) while the webview keeps displaying the
 * ORIGINAL file, whose encryption state never changes. Regression: both
 * handlers used to post { c: "encState" } after the operation, which flipped
 * the bottom-left button of the still-displayed archive — encrypting a plain
 * archive showed "Decrypt" and decrypting an encrypted one showed "Encrypt".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { __inputBoxes } from "./__mocks__/vscode";
import type { HandlerState } from "../src/providers/webview/state";
import type { HandlerContext } from "../src/providers/webview/handlers/types";
import { handleEncrypt } from "../src/providers/webview/handlers/encrypt";
import { handleDecrypt } from "../src/providers/webview/handlers/decrypt";
import { convertArchive } from "../src/services/archiveService";

vi.mock("../src/services/archiveService", () => ({
  convertArchive: vi.fn(async () => {}),
}));

const SRC = "C:\\arc\\a.7z";

function makeCtx(overrides?: Partial<HandlerState>): {
  webview: vscode.Webview;
  state: HandlerState;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const postMessage = vi.fn();
  const webview = { postMessage } as unknown as vscode.Webview;
  const state: HandlerState = {
    archiveUri: vscode.Uri.file(SRC),
    archiveName: "a.7z",
    filePath: SRC,
    password: undefined,
    entries: [],
    entryIndex: new Map(),
    isEncrypted: false,
    cancelSource: null,
    ...overrides,
  };
  return { webview, state, postMessage };
}

/** Drive the two password input boxes of the encrypt flow. */
async function runEncrypt(ctx: HandlerContext): Promise<void> {
  const p = handleEncrypt(ctx);
  await vi.waitFor(() => expect(__inputBoxes().length).toBe(1));
  __inputBoxes()[0].accept("pw");
  await vi.waitFor(() => expect(__inputBoxes().length).toBe(2));
  __inputBoxes()[1].accept("pw");
  await p;
}

describe("webview encrypt handler", () => {
  beforeEach(() => {
    vi.mocked(convertArchive).mockClear();
  });

  it("writes …_encrypted.7z with the new password", async () => {
    const { webview, state } = makeCtx();
    await runEncrypt({ webview, state, msg: { c: "encrypt" } });

    expect(vi.mocked(convertArchive)).toHaveBeenCalledTimes(1);
    const [srcPath, fmt, dstPath, password, , outputPassword] =
      vi.mocked(convertArchive).mock.calls[0];
    expect(srcPath).toBe(SRC);
    expect(fmt).toBe("7z");
    expect(dstPath).toBe("C:\\arc\\a_encrypted.7z");
    expect(password).toBe("");
    expect(outputPassword).toBe("pw");
  });

  it("does not flip the status-bar button of the still-displayed original (no encState)", async () => {
    const { webview, state, postMessage } = makeCtx();
    await runEncrypt({ webview, state, msg: { c: "encrypt" } });

    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls.map((c) => c[0])).toEqual([
      { c: "loading", t: expect.any(String) },
      { c: "ok", t: expect.any(String) },
      { c: "loading", t: false },
    ]);
  });
});

describe("webview decrypt handler", () => {
  beforeEach(() => {
    vi.mocked(convertArchive).mockClear();
  });

  it("writes …_decrypted.7z with an empty output password", async () => {
    const { webview, state } = makeCtx({ password: "pw", isEncrypted: true });
    await handleDecrypt({ webview, state, msg: { c: "decrypt" } });

    expect(vi.mocked(convertArchive)).toHaveBeenCalledTimes(1);
    const [srcPath, fmt, dstPath, password, , outputPassword] =
      vi.mocked(convertArchive).mock.calls[0];
    expect(srcPath).toBe(SRC);
    expect(fmt).toBe("7z");
    expect(dstPath).toBe("C:\\arc\\a_decrypted.7z");
    expect(password).toBe("pw");
    expect(outputPassword).toBe("");
  });

  it("does not flip the status-bar button of the still-displayed original (no encState)", async () => {
    const { webview, state, postMessage } = makeCtx({ password: "pw", isEncrypted: true });
    await handleDecrypt({ webview, state, msg: { c: "decrypt" } });

    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage.mock.calls.map((c) => c[0])).toEqual([
      { c: "loading", t: expect.any(String) },
      { c: "ok", t: expect.any(String) },
      { c: "loading", t: false },
    ]);
  });
});
