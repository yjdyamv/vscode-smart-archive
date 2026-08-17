/**
 * Webview helpers — Smart Archiver VSCode Extension
 *
 * Shared utility functions used by both webview setup and message routing.
 *
 * @module providers/webview/helpers
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FORMAT_TABLE, NOISY_DIR_PATTERNS, getFullExt } from "../../constants";
import { EXT_ID } from "./state";
import { t } from "../../i18n";

export function getNoisyPatterns(): string[] {
  return (
    vscode.workspace.getConfiguration("smart-archiver").get<string[]>("patterns.collapsedDirs") ??
    NOISY_DIR_PATTERNS
  );
}

const READ_ONLY_EXTS: ReadonlySet<string> = new Set(
  FORMAT_TABLE.filter((f) => !f.canCreate).flatMap((f) => f.exts),
);

export function isReadOnlyExt(ext: string): boolean {
  return READ_ONLY_EXTS.has(ext);
}

export function showErrorWithCopy(msg: string): void {
  vscode.window.showErrorMessage(msg, t("generic.copy")).then((action) => {
    if (action === t("generic.copy")) vscode.env.clipboard.writeText(msg);
  });
}

export function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = getFullExt(filePath) || path.extname(filePath);
  const base = path.basename(filePath, ext);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base}_${i}${ext}`))) i++;
  return path.join(dir, `${base}_${i}${ext}`);
}

export function getWebviewUris(webview: vscode.Webview): {
  cssUri: string;
  jsUri: string;
  codiconCssUri: string;
} {
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) throw new Error(`Extension ${EXT_ID} not found`);
  const extUri = ext.extensionUri;
  return {
    cssUri: webview
      .asWebviewUri(vscode.Uri.joinPath(extUri, "media", "vue", "assets", "style.css"))
      .toString(),
    jsUri: webview
      .asWebviewUri(vscode.Uri.joinPath(extUri, "media", "vue", "assets", "index.js"))
      .toString(),
    codiconCssUri: webview
      .asWebviewUri(
        vscode.Uri.joinPath(extUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css"),
      )
      .toString(),
  };
}
