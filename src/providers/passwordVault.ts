/**
 * Password vault — Smart Archiver VSCode Extension
 *
 * Session-scoped storage of archive passwords in VS Code's SecretStorage
 * (OS keychain: Keychain on macOS, Credential Manager on Windows, libsecret
 * on Linux), so re-opening an encrypted archive within the same session —
 * after closing the tab or the archive browser — does not require the
 * password again.
 *
 * Security — the key carries a per-session random id
 * (`pw:<sessionId>:<sha256(path)>`):
 *   - A new session (VS Code restart, extension update/uninstall, or a
 *     crash followed by relaunch) generates a fresh session id, so the
 *     previous session's passwords are unreachable and must be re-entered.
 *     This holds even when deactivate never runs.
 *   - Graceful shutdown awaits the SecretStorage deletes, so normal
 *     close/update does not leave the session's keys in the keychain
 *     (a crashed session's keys linger unused — SecretStorage offers no
 *     enumeration to sweep them, and they remain OS-keychain-protected).
 *   - The archive path never appears in the key; passwords are only
 *     written after a successful unlock and never logged.
 *
 * @module providers/passwordVault
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import { logger } from "../utils/logger";

let _secrets: vscode.SecretStorage | null = null;
let _sessionId = "";
const _secretKeys = new Set<string>();

export function initPasswordVault(secrets: vscode.SecretStorage): void {
  _secrets = secrets;
  _sessionId = crypto.randomUUID();
  _secretKeys.clear();
}

/**
 * Delete every password stored this session and sever the storage handle.
 * Async and awaited by extension deactivate — VS Code waits for the
 * returned promise, so the keychain deletions actually land before the
 * host shuts down.
 */
export async function disposePasswordVault(): Promise<void> {
  if (_secrets) {
    await Promise.allSettled([..._secretKeys].map((key) => _secrets!.delete(key)));
  }
  _secretKeys.clear();
  _secrets = null;
  _sessionId = "";
}

function secretKey(filePath: string): string {
  return `pw:${_sessionId}:${crypto.createHash("sha256").update(filePath).digest("hex")}`;
}

/** Store a successfully verified password for the session. */
export async function saveArchivePassword(filePath: string, password: string): Promise<void> {
  if (!_secrets || !password) return;
  const key = secretKey(filePath);
  try {
    await _secrets.store(key, password);
    _secretKeys.add(key);
    logger.debug({ event: "passwordVault.saved", filePath });
  } catch (err) {
    logger.warn({ event: "passwordVault.save.failed", err }, "Failed to store password");
  }
}

/** Read a previously stored password for this session (undefined = none). */
export async function getCachedArchivePassword(filePath: string): Promise<string | undefined> {
  if (!_secrets) return undefined;
  try {
    return (await _secrets.get(secretKey(filePath))) || undefined;
  } catch (err) {
    logger.warn({ event: "passwordVault.get.failed", err }, "Failed to read stored password");
    return undefined;
  }
}
