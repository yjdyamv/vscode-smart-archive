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
import * as path from "path";
import { compressCommand } from "./commands/compress";
import { repairCommand } from "./commands/repair";
import { decompressCommand, browseCommand } from "./commands/decompress";
import { registerArchiveEditor, pasteCopiedFromArchive } from "./providers/archiveProvider";
import { runAddToArchive } from "./providers/archive";
import { logger } from "./utils/logger";
import {
  init as initExpandedState,
  dispose as disposeExpandedState,
} from "./providers/webview/expandedState";
import { initTempCleanup } from "./providers/tempFiles";
import { initListingCache } from "./providers/listingCache";
import { initPreviewCache } from "./providers/previewCache";
import { initPasswordVault, disposePasswordVault } from "./providers/passwordVault";
import { resetDetectionCache } from "./engines/system7z";
import { applyHostConfig } from "./utils/config";
import { disposeBurstLoggers } from "./providers/webview/router";
import { resetArchiveRunner, reconfigureArchiveWorker } from "./engines/worker/runner";

/**
 * Called when the extension is activated.
 * VSCode triggers this the first time either command is executed.
 *
 * @param context - Extension context for managing subscriptions
 */
export function activate(context: vscode.ExtensionContext): void {
  logger.info({ event: "extension.activate", vscode: vscode.version });

  applyHostConfig();

  initExpandedState(context.secrets);
  initPasswordVault(context.secrets);
  initTempCleanup(context);
  initListingCache(path.join(context.globalStorageUri.fsPath, "listing-cache"));
  initPreviewCache(path.join(context.globalStorageUri.fsPath, "preview-cache"));

  // Register custom editor as default viewer for archive files (.7z, .zip, …)
  registerArchiveEditor(context);
  logger.info({ event: "extension.archiveProvider.registered" });

  // Invalidate cached engine detection when the relevant setting changes, so
  // switching sevenZBackend (e.g. to "bundled") applies without a window
  // reload. applyHostConfig already re-applies the other engine settings
  // (including zstd/rar5/snappy backend cache resets via engine-config).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      applyHostConfig();
      // Push the new values into a live worker too — without this, the
      // worker keeps stale limits/zstd settings until it is restarted.
      reconfigureArchiveWorker();
      if (e.affectsConfiguration("smart-archive.sevenZBackend")) resetDetectionCache();
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

  // Register repair command
  const repairDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.repair",
    (uri: vscode.Uri) => repairCommand(uri),
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
    repairDisposable,
  );
}

/**
 * Called when the extension is deactivated.
 * VSCode automatically disposes of all subscriptions.
 */
export async function deactivate(): Promise<void> {
  disposeExpandedState();
  await disposePasswordVault();
  disposeBurstLoggers();
  resetArchiveRunner();
  logger.info({ event: "extension.deactivate" });
  logger.dispose();
}
