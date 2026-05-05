/**
 * Webview helpers — Smart Archive VSCode Extension
 *
 * Shared utility functions used by both webview setup and message routing.
 *
 * @module providers/webview/helpers
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { NOISY_DIR_PATTERNS } from "../../constants";
import { EXT_ID } from "./state";

export function getNoisyPatterns(): string[] {
  return (
    vscode.workspace.getConfiguration("smart-archive").get<string[]>("collapsedDirPatterns") ??
    NOISY_DIR_PATTERNS
  );
}

export function isReadOnlyExt(ext: string): boolean {
  return [
    ".rar",
    ".iso",
    ".vhd",
    ".vmdk",
    ".dmg",
    ".hfs",
    ".fat",
    ".ntfs",
    ".deb",
    ".rpm",
  ].includes(ext);
}

export function showErrorWithCopy(msg: string): void {
  vscode.window.showErrorMessage(msg, "Copy").then((action) => {
    if (action === "Copy") vscode.env.clipboard.writeText(msg);
  });
}

export function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
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
  const extUri = vscode.extensions.getExtension(EXT_ID)!.extensionUri;
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
