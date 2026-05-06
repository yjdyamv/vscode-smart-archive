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
import { EXT_ID } from "./webview/state";

class ArchiveEditorProvider implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const extUri = vscode.extensions.getExtension(EXT_ID)!.extensionUri;
    webviewPanel.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [extUri],
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
}

export async function openArchivePreview(archiveUri: vscode.Uri): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "archiveViewer",
    t("decompress.previewTitle"),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.extensions.getExtension(EXT_ID)!.extensionUri],
    },
  );
  await setupWebview(panel.webview, archiveUri);
}

export { pasteCopiedFromArchive };
