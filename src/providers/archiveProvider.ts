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
import { logger } from "../utils/logger";

class ArchiveEditorProvider implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension(EXT_ID);
      if (!ext) throw new Error(`Extension ${EXT_ID} not found`);
      const extUri = ext.extensionUri;
      webviewPanel.webview.options = {
        enableScripts: true,
        enableCommandUris: false,
        localResourceRoots: [extUri],
      };
      await setupWebview(webviewPanel.webview, document.uri);
    } catch (err) {
      logger.error({ event: "resolveCustomEditor.failed", err }, (err as Error).message);
      throw err;
    }
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
  try {
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext) throw new Error(`Extension ${EXT_ID} not found`);
    const panel = vscode.window.createWebviewPanel(
      "archiveViewer",
      t("decompress.previewTitle"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [ext.extensionUri],
      },
    );
    await setupWebview(panel.webview, archiveUri);
  } catch (err) {
    logger.error({ event: "openArchivePreview.failed", err }, (err as Error).message);
    throw err;
  }
}

export { pasteCopiedFromArchive };
