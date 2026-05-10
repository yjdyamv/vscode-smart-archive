/**
 * Persistent expanded state — Smart Archive VSCode Extension
 *
 * Dual-storage strategy:
 * - Non-encrypted archives: in-memory Map, destroyed on VS Code close.
 * - Encrypted archives:   SecretStorage (OS-level encryption), with keys
 *   tracked and deleted on extension deactivate (session scoped).
 *
 * @module providers/webview/expandedState
 */

import * as vscode from "vscode";
import * as crypto from "crypto";

let _secrets: vscode.SecretStorage | null = null;
const _sessionState = new Map<string, string[]>();
const _secretKeys = new Set<string>();

export function init(secrets: vscode.SecretStorage): void {
  _secrets = secrets;
  _sessionState.clear();
  _secretKeys.clear();
}

export function dispose(): void {
  if (_secrets) {
    for (const key of _secretKeys) {
      _secrets.delete(key);
    }
  }
  _sessionState.clear();
  _secretKeys.clear();
}

function hashKey(uri: string): string {
  return crypto.createHash("sha256").update(uri).digest("hex");
}

export async function saveExpandedPaths(
  archiveUri: vscode.Uri,
  paths: string[],
  encrypted: boolean,
): Promise<void> {
  if (encrypted) {
    if (!_secrets) return;
    const key = `expanded:${hashKey(archiveUri.toString())}`;
    await _secrets.store(key, JSON.stringify(paths));
    _secretKeys.add(key);
  } else {
    _sessionState.set(archiveUri.toString(), paths);
  }
}

export async function loadExpandedPaths(
  archiveUri: vscode.Uri,
  encrypted: boolean,
): Promise<string[]> {
  if (encrypted) {
    if (!_secrets) return [];
    const key = `expanded:${hashKey(archiveUri.toString())}`;
    const raw = await _secrets.get(key);
    return raw ? JSON.parse(raw) : [];
  }
  return _sessionState.get(archiveUri.toString()) ?? [];
}
