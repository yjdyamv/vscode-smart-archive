/**
 * Extension entry point — Smart Archive VSCode Extension
 *
 * Registers three commands (compress, decompress, browse) and the
 * custom archive viewer editor. All heavy lifting is delegated to
 * the commands/ and engines/ modules.
 *
 * @module extension
 */

import * as vscode from "vscode";
import { compressCommand } from "./commands/compress";
import { decompressCommand, browseCommand } from "./commands/decompress";
import { registerArchiveEditor, pasteCopiedFromArchive } from "./providers/archiveProvider";
import { runAddToArchive } from "./providers/archive";
import { logger } from "./utils/logger";
import {
  init as initExpandedState,
  dispose as disposeExpandedState,
} from "./providers/webview/expandedState";
import { initTempCleanup } from "./providers/tempFiles";
import { resetDetectionCache } from "./engines/system7z";

/**
 * Called when the extension is activated.
 * VSCode triggers this the first time either command is executed.
 *
 * @param context - Extension context for managing subscriptions
 */
export function activate(context: vscode.ExtensionContext): void {
  logger.info({ event: "extension.activate", vscode: vscode.version });

  initExpandedState(context.secrets);
  initTempCleanup(context);

  // Register custom editor as default viewer for archive files (.7z, .zip, …)
  registerArchiveEditor(context);
  logger.info({ event: "extension.archiveProvider.registered" });

  // Invalidate cached 7-Zip engine detection when the setting changes, so
  // switching useSystem7z (e.g. to "bundled") applies without a window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("smart-archive.useSystem7z")) resetDetectionCache();
    }),
  );

  // Register compress command
  const compressDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.compress",
    (uri: vscode.Uri, selectedUris: readonly vscode.Uri[]) => compressCommand(uri, selectedUris),
  );

  // Register decompress command
  const decompressDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.decompress",
    (uri: vscode.Uri, selectedUris: readonly vscode.Uri[]) => decompressCommand(uri, selectedUris),
  );

  // Register browse command
  const browseDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.browse",
    (uri: vscode.Uri) => browseCommand(uri),
  );

  // Register paste-from-archive command
  const pasteDisposable = vscode.commands.registerCommand("yjdyamv.smart-archive.paste", () =>
    pasteCopiedFromArchive(),
  );

  // Register add-to-archive command (triggered via command URI from webview)
  const addToArchiveDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.addToArchive",
    () => runAddToArchive(),
  );

  // Dispose commands when the extension is deactivated
  context.subscriptions.push(
    compressDisposable,
    decompressDisposable,
    browseDisposable,
    pasteDisposable,
    addToArchiveDisposable,
  );
}

/**
 * Called when the extension is deactivated.
 * VSCode automatically disposes of all subscriptions.
 */
export function deactivate(): void {
  disposeExpandedState();
  logger.info({ event: "extension.deactivate" });
  logger.dispose();
}
