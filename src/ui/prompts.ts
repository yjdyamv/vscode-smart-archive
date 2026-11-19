/**
 * VSCode UI prompts — Smart Archiver VSCode Extension
 *
 * Shared dialog helpers:
 * - Password input (masked)
 * - File save dialog
 * - Volume size picker
 * - The free-text picker (`promptValuePick`) every parameter step builds on
 *
 * All displayed strings are localized via the i18n module.
 *
 * @module ui/prompts
 */

import * as vscode from "vscode";
import * as path from "path";
import type { PasswordResult } from "../types";
import { getVolumeSizes } from "../utils/volume-sizes";
import { parseSize } from "../utils/security";
import { t, formatCompactSize } from "../i18n";

/** Outcome of one navigable wizard step: answered, backed out, or cancelled. */
export type StepResult<T> = { kind: "ok"; value: T } | { kind: "back" } | { kind: "cancel" };

/** One preset row of a `promptValuePick` ladder. */
export interface ValuePickRow<T> extends vscode.QuickPickItem {
  value: T;
}

/**
 * Normalize a numeric field typed by a human.
 *
 * Full-width characters (Chinese IME), stray spaces, and case all show up in
 * real input: "５０ ０Ｍｂ", "1.5 gb", "100 m". Everything downstream can then
 * assume plain ascii digits, one unit letter, no whitespace.
 */
export function normalizeNumericInput(raw: string): string {
  return raw
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * A step whose answer is the picker's own input field.
 *
 * The rows are a preset ladder, not a gate in front of typing: text typed into
 * the picker is parsed on Enter and wins over whatever row happens to be
 * highlighted (typing "1" must not be swallowed by the "1440K" row), so no
 * "Custom…" row has to be selected before anything can be typed.
 *
 * An empty field is not an error — Enter then takes the highlighted row, and
 * because the step's default is ordered first that doubles as "take the
 * default". A field that does not parse keeps the picker open with a pinned
 * first row saying so, rather than accepting nothing, closing, or cancelling.
 * Only Esc cancels.
 *
 * @param opts.items        Preset ladder; the first row is what an empty Enter takes
 * @param opts.parse        Typed text → value, or undefined when it is not a value
 * @param opts.describe     Pinned-row label for a typed value; every step says
 *                          what the typed text will mean (`Use 5 MiB per volume`)
 * @param opts.invalid      Optional pinned-row label for text that does not parse;
 *                          say what the field wants, not just that it failed
 */
export function promptValuePick<T>(opts: {
  items: readonly ValuePickRow<T>[];
  placeHolder: string;
  title?: string;
  parse: (raw: string) => T | undefined;
  describe: (value: T, raw: string) => string;
  invalid?: (raw: string) => string;
}): Promise<StepResult<T>> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<ValuePickRow<T>>();
    let result: "accept" | "back" | "cancel" | null = null;
    let chosen: T | undefined;

    // The pinned row is rebuilt on every keystroke: it is the only feedback a
    // QuickPick can give (QuickPick has no validationMessage — only InputBox).
    const rebuild = (): void => {
      const raw = qp.value.trim();
      const typed = raw ? opts.parse(raw) : undefined;
      const rows: ValuePickRow<T>[] = [];
      if (raw) {
        rows.push({
          label:
            typed === undefined
              ? (opts.invalid?.(raw) ?? t("wizard.inputInvalid", raw))
              : opts.describe(typed, raw),
          value: typed as T,
          alwaysShow: true,
        });
      }
      rows.push(...opts.items);
      qp.items = rows;
    };

    qp.title = opts.title;
    qp.placeholder = opts.placeHolder;
    qp.ignoreFocusOut = true;
    qp.buttons = [vscode.QuickInputButtons.Back];
    rebuild();
    qp.onDidChangeValue(() => rebuild());
    qp.onDidAccept(() => {
      const raw = qp.value.trim();
      if (raw) {
        const typed = opts.parse(raw);
        if (typed === undefined) return; // the pinned row explains why; stay open
        chosen = typed;
      } else {
        const picked = qp.selectedItems[0];
        if (!picked) return; // nothing typed, nothing highlighted: keep waiting
        chosen = picked.value;
      }
      result = "accept";
      qp.hide();
    });
    qp.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) {
        result = "back";
        qp.hide();
      }
    });
    qp.onDidHide(() => {
      if (result === "accept") resolve({ kind: "ok", value: chosen as T });
      else if (result === "back") resolve({ kind: "back" });
      else resolve({ kind: "cancel" });
    });
    qp.show();
  });
}

/**
 * The password box currently on screen, if any.
 *
 * A native QuickInput exposes no keyboard events, and its buttons can only be
 * clicked, so a shortcut cannot live inside the box. It comes from outside:
 * package.json binds Ctrl+H while a quick input is focused, and that command
 * lands here.
 */
let activePasswordToggle: (() => void) | undefined;

/** Hand Ctrl+H the live password box; call the returned function when it hides. */
export function registerPasswordToggle(toggle: () => void): () => void {
  activePasswordToggle = toggle;
  return () => {
    if (activePasswordToggle === toggle) activePasswordToggle = undefined;
  };
}

/** Flip the live password box between masked and plain text (Ctrl+H). */
export function togglePasswordVisible(): void {
  activePasswordToggle?.();
}

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
      tooltip: t("password.showHint"),
    };
    const eyeOffBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("eye-closed"),
      tooltip: t("password.hideHint"),
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
    const toggle = (): void => {
      shown = !shown;
      ib.password = !shown;
      ib.buttons = shown
        ? [eyeOffBtn, clearBtn, vscode.QuickInputButtons.Back]
        : [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
    };
    const release = registerPasswordToggle(toggle);
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
        toggle();
      } else {
        ib.hide();
        resolve(null);
      }
    });
    ib.onDidHide(() => {
      release();
      resolve(null);
    });
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

/**
 * Parse a typed volume size: a number with a k/m/g suffix.
 *
 * Tolerates what people actually type — "1.1m", "100 M", "100mb", "1.5 GiB",
 * "５０Ｍ" — and normalizes it to `100m` form.
 *
 * A bare number is rejected on purpose — `parseSize()` needs the unit and
 * silently falls back to a default without it, which would compress into
 * something other than what was typed.
 */
export function parseVolumeSizeInput(raw: string): string | undefined {
  // "100mb" / "1.5gib" mean the same as "100m" / "1.5g" to the parser behind them.
  const s = normalizeNumericInput(raw).replace(/(?:i?b)$/, "");
  if (!/^\d+(?:\.\d+)?[kmg]$/.test(s)) return undefined;
  return parseFloat(s) > 0 ? s : undefined;
}

/**
 * Ask for a split-volume size.
 *
 * Same model as the compress wizard: type `100m` and press Enter, or pick a
 * preset; an empty Enter takes the highlighted preset. Only Esc/cancel returns
 * undefined. Split must produce volumes, so "Don't split" is not offered here.
 */
export async function promptVolumeSize(): Promise<string | undefined> {
  const res = await promptValuePick<string>({
    items: getVolumeSizes().map((v) => ({
      label: v.label,
      value: v.value,
      description: v.description,
    })),
    placeHolder: t("compress.selectVolume"),
    parse: parseVolumeSizeInput,
    describe: (v) => t("wizard.inputUseSize", v, formatCompactSize(parseSize(v, 0))),
    invalid: (raw) => t("wizard.inputInvalidSize", raw),
  });
  return res.kind === "ok" ? res.value : undefined;
}
