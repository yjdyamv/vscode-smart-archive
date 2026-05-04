/**
 * VSCode UI prompts — 7z VSCode Extension
 *
 * Encapsulates all user-facing VSCode dialogs:
 * - Format picker (QuickPick)
 * - Encryption confirmation
 * - Password input (masked)
 * - File save dialog
 *
 * All displayed strings are localized via the i18n module.
 *
 * @module ui/prompts
 */

import * as vscode from "vscode";
import * as path from "path";
import type { FormatInfo, PasswordResult, EncryptChoice } from "../types";
import { COMPRESS_FORMATS } from "../constants";
import { t, compressLevels } from "../i18n";

/**
 * Show a format selection dropdown.
 * Only formats with `canCreate === true` are shown.
 *
 * @returns The chosen format, or undefined if the user cancelled
 */
export async function promptCompressFormat(): Promise<FormatInfo | undefined> {
  const items = COMPRESS_FORMATS.map((f) => ({
    label: f.label,
    description: f.description,
  }));

  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: t("compress.selectFormat"),
    ignoreFocusOut: true,
  });

  if (!chosen) return undefined;
  return COMPRESS_FORMATS.find((f) => f.label === chosen.label);
}

/**
 * Ask the user whether to enable AES-256 encryption.
 *
 * @returns true=encrypt, false=no encryption, null=cancelled
 */
export async function promptEncryptChoice(): Promise<EncryptChoice> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: t("encrypt.no"), description: "" },
      { label: t("encrypt.yes"), description: "" },
    ],
    { placeHolder: t("encrypt.title"), ignoreFocusOut: true },
  );
  if (!choice) return null;
  return choice.label === t("encrypt.yes");
}

/**
 * Show a masked password input box.
 * Empty input = skip password.
 *
 * @param hint - Placeholder hint (from i18n)
 * @returns Password string ('' = skip) or null if cancelled
 */
export async function promptPassword(hint: string): Promise<PasswordResult> {
  const password = await vscode.window.showInputBox({
    prompt: t("password.prompt"),
    placeHolder: hint,
    password: true,
    ignoreFocusOut: true,
  });
  // ESC → undefined → null
  if (password === undefined) return null;
  return password;
}

/**
 * Show a "Save As" dialog for the output archive.
 *
 * @param targetPath - Path of the first selected item (used to derive default location)
 * @param targetCount - How many items are selected (1 = use item name, >1 = 'archive')
 * @param format - Archive format extension (e.g. '7z')
 * @returns The chosen save URI, or undefined if cancelled
 */
export async function promptSavePath(
  targetPath: string,
  targetCount: number,
  format: string,
): Promise<vscode.Uri | undefined> {
  let defaultUri: vscode.Uri;

  if (targetCount === 1) {
    const base = path.basename(targetPath, path.extname(targetPath));
    defaultUri = vscode.Uri.file(path.join(path.dirname(targetPath), `${base}.${format}`));
  } else {
    defaultUri = vscode.Uri.file(path.join(path.dirname(targetPath), `archive.${format}`));
  }

  return vscode.window.showSaveDialog({
    defaultUri,
    filters: { [t("save.filterName")]: [format] },
  });
}

const LEVEL_VALUES = [0, 1, 3, 5, 7, 9];

export async function promptCompressLevel(): Promise<number> {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const defaultLevel = config.get<number>("defaultCompressionLevel", 5);
  const labels = compressLevels();

  // Place the configured default level first so it's highlighted and
  // selected by default when the user presses Enter without picking.
  const defaultIdx = LEVEL_VALUES.indexOf(defaultLevel);
  const order = LEVEL_VALUES.map((_, i) => i);
  if (defaultIdx >= 0) {
    order.splice(defaultIdx, 1);
    order.unshift(defaultIdx);
  }

  const items = order.map((i) => ({ label: labels[i] }));

  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: t("compress.selectLevel"),
    ignoreFocusOut: true,
  });

  if (!chosen) return defaultLevel;
  const idx = labels.indexOf(chosen.label);
  return idx >= 0 ? LEVEL_VALUES[idx] : defaultLevel;
}

const VOLUME_SIZES = [
  { label: "1.44M", value: "1440k" },
  { label: "10M", value: "10m" },
  { label: "50M", value: "50m" },
  { label: "100M", value: "100m" },
  { label: "200M", value: "200m" },
  { label: "650M", value: "650m" },
  { label: "700M", value: "700m" },
  { label: "1G", value: "1g" },
  { label: "2G", value: "2g" },
  { label: "4.7G", value: "4700m" },
];

export async function promptVolumeSize(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const defaultSize = config.get<string>("defaultVolumeSize") || "";

  const items = [
    { label: t("compress.volume.none"), value: undefined as string | undefined },
    ...VOLUME_SIZES.map((v) => ({ label: v.label, value: v.value })),
    { label: t("compress.volume.custom"), value: "__custom__" },
  ];

  // Place the configured default at the top so it's highlighted and
  // selected by default when the user presses Enter.
  if (defaultSize) {
    const defaultIdx = items.findIndex((i) => i.value === defaultSize);
    if (defaultIdx > 0) {
      const [def] = items.splice(defaultIdx, 1);
      items.splice(1, 0, def);
    } else if (defaultIdx < 0) {
      // Custom default not in preset list — insert after "Don't split"
      items.splice(1, 0, {
        label: `${defaultSize} (custom)`,
        value: defaultSize,
      });
    }
  }

  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: t("compress.selectVolume"),
    ignoreFocusOut: true,
  });

  if (!chosen) return undefined;
  if (chosen.value === "__custom__") {
    return (
      vscode.window.showInputBox({
        prompt: t("compress.volume.prompt"),
        placeHolder: "100m",
        validateInput: (v) => (/^\d+[kmg]?$/i.test(v.trim()) ? null : t("compress.volume.invalid")),
      }) || undefined
    );
  }
  return chosen.value;
}
