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
import { logger } from "./utils/logger";

/**
 * Called when the extension is activated.
 * VSCode triggers this the first time either command is executed.
 *
 * @param context - Extension context for managing subscriptions
 */
export function activate(context: vscode.ExtensionContext): void {
  logger.info({ event: "extension.activate", vscode: vscode.version });

  // Register custom editor as default viewer for archive files (.7z, .zip, …)
  registerArchiveEditor(context);
  logger.info({ event: "extension.archiveProvider.registered" });

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

  // Dispose commands when the extension is deactivated
  context.subscriptions.push(
    compressDisposable,
    decompressDisposable,
    browseDisposable,
    pasteDisposable,
  );
}

/**
 * Called when the extension is deactivated.
 * VSCode automatically disposes of all subscriptions.
 */
export function deactivate(): void {
  logger.info({ event: "extension.deactivate" });
  logger.dispose();
}
