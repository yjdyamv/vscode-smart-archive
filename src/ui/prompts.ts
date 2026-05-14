/**
 * VSCode UI prompts — Smart Archive VSCode Extension
 *
 * Shared dialog helpers:
 * - Password input (masked)
 * - File save dialog
 * - Volume size picker
 *
 * All displayed strings are localized via the i18n module.
 *
 * @module ui/prompts
 */

import * as vscode from "vscode";
import * as path from "path";
import type { PasswordResult } from "../types";
import { VOLUME_SIZES } from "../constants";
import { t } from "../i18n";

/**
 * Show a masked password input box.
 * Empty input = skip password.
 *
 * @param hint - Placeholder hint (from i18n)
 * @returns Password string ('' = skip) or null if cancelled
 */
export async function promptPassword(hint: string): Promise<PasswordResult> {
  return new Promise<PasswordResult>((resolve) => {
    const ib = vscode.window.createInputBox();
    let shown = false;
    const eyeBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("eye"),
      tooltip: t("password.show"),
    };
    const eyeOffBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("eye-closed"),
      tooltip: t("password.hide"),
    };
    const clearBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("close"),
      tooltip: t("input.clear"),
    };
    ib.prompt = t("password.prompt");
    ib.placeholder = hint;
    ib.password = true;
    ib.ignoreFocusOut = true;
    ib.buttons = [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
    ib.onDidAccept(() => {
      const val = ib.value;
      ib.hide();
      resolve(val);
    });
    ib.onDidChangeValue(() => {
      if (shown) {
        shown = false;
        ib.password = true;
        ib.buttons = [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
      }
    });
    ib.onDidTriggerButton((b) => {
      if (b === clearBtn) {
        ib.value = "";
      } else if (b === eyeBtn || b === eyeOffBtn) {
        shown = !shown;
        ib.password = !shown;
        ib.buttons = shown
          ? [eyeOffBtn, clearBtn, vscode.QuickInputButtons.Back]
          : [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
      } else {
        ib.hide();
        resolve(null);
      }
    });
    ib.onDidHide(() => resolve(null));
    ib.show();
  });
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
  saveDir?: string,
): Promise<vscode.Uri | undefined> {
  let defaultUri: vscode.Uri;
  const dir = saveDir ?? path.dirname(targetPath);

  if (targetCount === 1) {
    // Keep original filename intact, append format: file.tar.gz → file.tar.gz.7z
    const base = path.basename(targetPath);
    defaultUri = vscode.Uri.file(path.join(dir, `${base}.${format}`));
  } else {
    defaultUri = vscode.Uri.file(path.join(dir, `archive.${format}`));
  }

  // Include the last-segment extension in the filter so VS Code
  // recognises compound extensions (.tar.lz4) on Windows save dialogs.
  const filterExts = [format];
  const dotIdx = format.lastIndexOf(".");
  if (dotIdx >= 0) filterExts.push(format.substring(dotIdx + 1));

  return vscode.window.showSaveDialog({
    defaultUri,
    filters: { [t("save.filterName")]: filterExts },
  });
}

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
