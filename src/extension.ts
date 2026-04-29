/**
 * Extension entry point — Smart Archive VSCode Extension
 *
 * Handles the VSCode extension lifecycle: activation and deactivation.
 * Registers two commands:
 *   - yjdyamv.smart-archive.compress    → compressCommand
 *   - yjdyamv.smart-archive.decompress  → decompressCommand
 *
 * Architecture overview:
 * ```
 * extension.ts (entry)
 *   ├── commands/compress.ts     → engines/js7z-engine.ts
 *   ├── commands/decompress.ts   → engines/js7z-engine.ts
 *   │                             → engines/libarchive-engine.ts
 *   ├── engines/js7z-engine.ts   → js7z-tools (7-Zip WASM)
 *   ├── engines/libarchive-engine.ts → libarchive.js (libarchive WASM)
 *   ├── ui/prompts.ts            → VSCode dialogs
 *   ├── i18n.ts                  → bilingual UI strings
 *   ├── utils/fs.ts              → local ↔ virtual FS sync
 *   └── utils/path.ts            → Unix-style path helpers
 * ```
 *
 * @module extension
 */

import * as vscode from "vscode";
import { compressCommand } from "./commands/compress";
import { decompressCommand, browseCommand } from "./commands/decompress";
import { registerArchiveEditor } from "./providers/archiveProvider";
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

  // Dispose commands when the extension is deactivated
  context.subscriptions.push(compressDisposable, decompressDisposable, browseDisposable);
}

/**
 * Called when the extension is deactivated.
 * VSCode automatically disposes of all subscriptions.
 */
export function deactivate(): void {
  logger.info({ event: "extension.deactivate" });
  logger.dispose();
}
