/**
 * Archive Provider — custom readonly editor for archive files (.7z, .zip, .rar, …).
 * Thin orchestrator that wires the editor provider, temp-file lifecycle,
 * webview handler, and public exports together for VSCode registration.
 *
 * @module providers/archiveProvider
 */

import * as vscode from "vscode";
import { t } from "../i18n";
import { initTempCleanup } from "./tempFiles";
import { setupWebview } from "./webviewHandler";
import { pasteCopiedFromArchive } from "./copyPaste";

class ArchiveEditorProvider implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
    };
    await setupWebview(webviewPanel.webview, document.uri);
  }
}

export function registerArchiveEditor(context: vscode.ExtensionContext): void {
  initTempCleanup(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider("archiveViewer", new ArchiveEditorProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prewarmLibarchive } = require("../engines/libarchive-engine") as {
    prewarmLibarchive: () => Promise<void>;
  };
  prewarmLibarchive();
}

export async function openArchivePreview(archiveUri: vscode.Uri): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "archiveViewer",
    t("decompress.previewTitle"),
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  await setupWebview(panel.webview, archiveUri);
}

export { pasteCopiedFromArchive };
