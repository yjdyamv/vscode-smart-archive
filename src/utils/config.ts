/**
 * Host config bridge — Smart Archive VSCode Extension
 *
 * Reads vscode workspace configuration and injects the values the
 * vscode-free engine layer needs (size limits, locale, zstd setting).
 * Call at activation and on configuration change.
 *
 * @module utils/config
 */

import * as vscode from "vscode";
import { parseSize, setSecurityLimits } from "./security";
import { setLocale } from "../i18n";
import { setZstdConfig } from "../engines/zstd-codec";

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB
const DEFAULT_MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024; // 10 GiB

/**
 * Push the current workspace configuration into the vscode-free engine
 * layer. Idempotent — safe to call at activation and on every
 * onDidChangeConfiguration event.
 */
export function applyHostConfig(): void {
  setLocale(vscode.env.language);

  const config = vscode.workspace.getConfiguration("smart-archive");
  setSecurityLimits({
    maxFileSize: parseSize(config.get<string | number>("maxFileSize"), DEFAULT_MAX_FILE_SIZE),
    maxTotalSize: parseSize(config.get<string | number>("maxTotalSize"), DEFAULT_MAX_TOTAL_SIZE),
  });

  setZstdConfig({
    useSystemZstd: config.get<string>("useSystemZstd", "auto"),
    warn: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
}
