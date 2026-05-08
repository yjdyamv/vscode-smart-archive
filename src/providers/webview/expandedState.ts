/**
 * Persistent expanded state — Smart Archive VSCode Extension
 *
 * Stores expanded directory paths via VS Code's SecretStorage API
 * (OS-level encryption: Credential Manager / Keychain / libsecret).
 * Key is hashed so the full archive path is never stored in plain text.
 *
 * @module providers/webview/expandedState
 */

import * as vscode from "vscode";
import * as crypto from "crypto";

let _secrets: vscode.SecretStorage | null = null;

export function setSecrets(secrets: vscode.SecretStorage): void {
  _secrets = secrets;
}

function hashKey(uri: string): string {
  return crypto.createHash("sha256").update(uri).digest("hex");
}

export async function saveExpandedPaths(
  archiveUri: vscode.Uri,
  paths: string[],
): Promise<void> {
  if (!_secrets) return;
  const key = `expanded:${hashKey(archiveUri.toString())}`;
  await _secrets.store(key, JSON.stringify(paths));
}

export async function loadExpandedPaths(archiveUri: vscode.Uri): Promise<string[]> {
  if (!_secrets) return [];
  const key = `expanded:${hashKey(archiveUri.toString())}`;
  const raw = await _secrets.get(key);
  return raw ? JSON.parse(raw) : [];
}
