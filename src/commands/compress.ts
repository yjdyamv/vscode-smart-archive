/**
 * Compress command handler — Smart Archive VSCode Extension
 *
 * Orchestrates the compression workflow:
 *   format → level → volume → encrypt → password → save → execute
 *
 * Each prompt step (except Save) shows a Back button so the user can
 * navigate to the previous step and correct a wrong selection.
 *
 * Stream formats (gz/bz2/xz) are single-file only. When the user selects
 * a folder or multiple files, we auto-upgrade to tar.gz/tar.bz2/tar.xz
 * to preserve directory structure.
 *
 * @module commands/compress
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { compressWith7z } from "../engines/js7z-engine";
import { COMPRESS_EXCLUDE_DEFAULTS, COMPRESS_FORMATS } from "../constants";
import { promptSavePath } from "../ui/prompts";
import type { CompressOptions, FormatInfo } from "../types";
import { t, compressLevels } from "../i18n";
import { logger } from "../utils/logger";

// ── Shared helpers for back-navigable QuickPick / InputBox ──

type StepResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "back" }
  | { kind: "cancel" };

function promptQuickPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  opts: {
    placeHolder: string;
    withBack?: boolean;
    title?: string;
    onSelect?: (item: T) => void;
  },
): Promise<StepResult<T>> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    let result: "accept" | "back" | "cancel" | null = null;
    qp.items = items as T[];
    qp.placeholder = opts.placeHolder;
    qp.title = opts.title;
    qp.ignoreFocusOut = true;
    if (opts.withBack !== false) {
      qp.buttons = [vscode.QuickInputButtons.Back];
    }
    qp.onDidAccept(() => {
      if (qp.selectedItems[0]) {
        result = "accept";
        qp.hide();
      }
    });
    qp.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) {
        result = "back";
        qp.hide();
      }
    });
    qp.onDidHide(() => {
      if (result === "accept") {
        resolve({ kind: "ok", value: qp.selectedItems[0] });
      } else if (result === "back") {
        resolve({ kind: "back" });
      } else {
        resolve({ kind: "cancel" });
      }
    });
    qp.onDidChangeSelection((sel) => {
      if (opts.onSelect && sel[0]) opts.onSelect(sel[0]);
    });
    qp.show();
  });
}

function promptInputBox(opts: {
  prompt: string;
  placeholder: string;
  password?: boolean;
  validate?: (v: string) => string | undefined;
}): Promise<StepResult<string>> {
  return new Promise((resolve) => {
    const ib = vscode.window.createInputBox();
    let result: "accept" | "back" | "cancel" | null = null;
    let shown = false;
    const eyeBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("eye"), tooltip: "Show password" };
    const eyeOffBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("eye-closed"), tooltip: "Hide password" };
    const clearBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("close"), tooltip: "Clear" };
    const isPw = !!opts.password;
    ib.prompt = opts.prompt;
    ib.placeholder = opts.placeholder;
    ib.password = isPw;
    ib.ignoreFocusOut = true;
    ib.buttons = isPw ? [eyeBtn, clearBtn, vscode.QuickInputButtons.Back] : [clearBtn, vscode.QuickInputButtons.Back];
    if (opts.validate) {
      ib.onDidChangeValue((v) => {
        ib.validationMessage = opts.validate!(v) ?? "";
      });
    }
    ib.onDidAccept(() => {
      if (opts.validate && opts.validate(ib.value)) return;
      result = "accept";
      ib.hide();
    });
    ib.onDidTriggerButton((b) => {
      if (b === clearBtn) {
        ib.value = "";
      } else if (isPw && (b === eyeBtn || b === eyeOffBtn)) {
        shown = !shown;
        ib.password = !shown;
        ib.buttons = shown ? [eyeOffBtn, clearBtn, vscode.QuickInputButtons.Back] : [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
      } else if (b === vscode.QuickInputButtons.Back) {
        result = "back";
        ib.hide();
      }
    });
    ib.onDidHide(() => {
      if (result === "accept") {
        resolve({ kind: "ok", value: ib.value });
      } else if (result === "back") {
        resolve({ kind: "back" });
      } else {
        resolve({ kind: "cancel" });
      }
    });
    ib.show();
  });
}

// ── Wizard prompts ──

const LEVEL_VALUES = [0, 1, 3, 5, 7, 9];

async function promptFormatWizard(): Promise<StepResult<FormatInfo>> {
  const items = COMPRESS_FORMATS.map((f) => ({ label: f.label, description: f.description }));
  const res = await promptQuickPick(items, {
    placeHolder: t("compress.selectFormat"),
    withBack: false,
    title: "Format",
  });
  if (res.kind !== "ok") return res;
  return {
    kind: "ok",
    value: COMPRESS_FORMATS.find((f) => f.label === res.value.label)!,
  };
}

async function promptLevelWizard(): Promise<StepResult<number>> {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const defaultLevel = config.get<number>("defaultCompressionLevel", 5);
  const labels = compressLevels();
  const defaultIdx = LEVEL_VALUES.indexOf(defaultLevel);
  const order = LEVEL_VALUES.map((_, i) => i);
  if (defaultIdx >= 0) {
    order.splice(defaultIdx, 1);
    order.unshift(defaultIdx);
  }
  const items = order.map((i) => ({ label: labels[i], level: LEVEL_VALUES[i] }));
  const res = await promptQuickPick(items, {
    placeHolder: t("compress.selectLevel"),
    title: "Step 2: Level",
  });
  if (res.kind !== "ok") return res;
  const idx = labels.indexOf(res.value.label);
  return { kind: "ok", value: idx >= 0 ? LEVEL_VALUES[idx] : defaultLevel };
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

async function promptVolumeWizard(): Promise<StepResult<string | undefined>> {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const defaultSize = config.get<string>("defaultVolumeSize") || "";
  const items: { label: string; value: string | undefined }[] = [
    { label: t("compress.volume.none"), value: undefined },
    ...VOLUME_SIZES.map((v) => ({ label: v.label, value: v.value })),
    { label: t("compress.volume.custom"), value: "__custom__" },
  ];
  if (defaultSize) {
    const defaultIdx = items.findIndex((i) => i.value === defaultSize);
    if (defaultIdx > 0) {
      const [def] = items.splice(defaultIdx, 1);
      items.splice(1, 0, def);
    } else if (defaultIdx < 0) {
      items.splice(1, 0, { label: `${defaultSize} (custom)`, value: defaultSize });
    }
  }
  const res = await promptQuickPick(items, {
    placeHolder: t("compress.selectVolume"),
    title: "Step 3: Volume size",
  });
  if (res.kind !== "ok") return res;
  if (res.value.value === "__custom__") {
    const ibRes = await promptInputBox({
      prompt: t("compress.volume.prompt"),
      placeholder: "100m",
      validate: (v) => (/^\d+[kmg]?$/i.test(v.trim()) ? undefined : t("compress.volume.invalid")),
    });
    if (ibRes.kind !== "ok") return ibRes;
    return { kind: "ok", value: ibRes.value };
  }
  return { kind: "ok", value: res.value.value };
}

async function promptEncryptWizard(): Promise<StepResult<boolean>> {
  const res = await promptQuickPick(
    [
      { label: t("encrypt.no"), value: false },
      { label: t("encrypt.yes"), value: true },
    ],
    { placeHolder: t("encrypt.title"), title: "Step 4: Encryption" },
  );
  if (res.kind !== "ok") return res;
  return { kind: "ok", value: res.value.value };
}

async function promptPasswordWizard(): Promise<StepResult<string>> {
  const res = await promptInputBox({
    prompt: t("password.prompt"),
    placeholder: t("password.encryptHint"),
    password: true,
  });
  if (res.kind !== "ok") return res;
  return { kind: "ok", value: res.value };
}

// ── Main command ──

export async function compressCommand(
  uri: vscode.Uri | undefined,
  selectedUris: readonly vscode.Uri[] | undefined,
): Promise<void> {
  const targets = selectedUris && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  if (targets.length === 0) {
    vscode.window.showErrorMessage(t("compress.noFiles"));
    return;
  }

  for (const target of targets) {
    if (!fs.existsSync(target.fsPath)) {
      vscode.window.showErrorMessage(t("compress.noFiles") + target.fsPath);
      return;
    }
  }

  // ── Wizard state ──
  let format: FormatInfo | undefined;
  let level = 5;
  let volumeSize: string | undefined;
  let doEncrypt = false;
  let password = "";

  let step = 1; // 1=format, 2=level, 3=volume, 4=encrypt, 5=password, 6=save

  while (true) {
    switch (step) {
      // ── 1. Format ──
      case 1: {
        const r = await promptFormatWizard();
        if (r.kind !== "ok") return; // cancel on first step → quit
        format = r.value;
        step = 2;
        continue;
      }

      // ── 2. Level ──
      case 2: {
        const r = await promptLevelWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") { step = 1; continue; }
          return;
        }
        level = r.value;
        const supSplit = ["7z", "zip"].includes(format!.label);
        step = supSplit ? 3 : 4; // skip volume if not splittable
        continue;
      }

      // ── 3. Volume size (7z/zip only) ──
      case 3: {
        const r = await promptVolumeWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") { step = 2; continue; }
          return;
        }
        volumeSize = r.value;
        step = 4;
        continue;
      }

      // ── 4. Encryption (if format supports it) ──
      case 4: {
        if (!format!.supportsEncryption) {
          step = 6; // skip to save
          continue;
        }
        const r = await promptEncryptWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") {
            step = ["7z", "zip"].includes(format!.label) ? 3 : 2;
            continue;
          }
          return;
        }
        doEncrypt = r.value;
        step = doEncrypt ? 5 : 6;
        continue;
      }

      // ── 5. Password ──
      case 5: {
        const r = await promptPasswordWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") { step = 4; continue; }
          return;
        }
        password = r.value;
        if (!password) {
          vscode.window.showWarningMessage(t("encrypt.noPassword"));
        }
        step = 6;
        continue;
      }

      // ── 6. Save & compress ──
      case 6: {
        const firstTarget = targets[0];
        const ext = format!.label;
        const saveUri = await promptSavePath(firstTarget.fsPath, targets.length, ext);
        if (!saveUri) {
          step = 2; // cancelled → back to level
          continue;
        }

        let outputPath = saveUri.fsPath;
        if (volumeSize) {
          const dir = path.dirname(outputPath);
          const base = path.basename(outputPath);
          const folderName = base.replace(/\.[^.]+$/, "");
          let folderPath = path.join(dir, folderName);
          if (fs.existsSync(folderPath)) {
            let i = 1;
            while (fs.existsSync(path.join(dir, `${folderName}_${i}`))) i++;
            folderPath = path.join(dir, `${folderName}_${i}`);
          }
          outputPath = path.join(folderPath, base);
        }

        const options: CompressOptions = {
          targets: targets.map((t) => ({ fsPath: t.fsPath })),
          format: {
            label: format!.label,
            description: "",
            canCreate: format!.canCreate,
            supportsEncryption: format!.supportsEncryption,
          },
          outputPath,
          password,
          level,
          volumeSize,
        };

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t("compress.progressTitle"),
            cancellable: true,
          },
          async (progress, token) => {
            try {
              const excludePatterns: string[] =
                vscode.workspace
                  .getConfiguration("smart-archive")
                  .get<string[]>("compressExcludePatterns") ?? COMPRESS_EXCLUDE_DEFAULTS;
              await compressWith7z(options, progress, token, excludePatterns);
            } catch (err) {
              logger.error({ event: "compress.command.failed", err }, "Compression failed");
              try {
                if (fs.existsSync(options.outputPath)) fs.unlinkSync(options.outputPath);
              } catch {
                logger.warn({ event: "compress.cleanup.failed" }, "Failed to clean up partial output file");
              }
              if (!(err instanceof vscode.CancellationError)) {
                vscode.window.showErrorMessage(t("compress.failed") + (err as Error).message);
              }
            }
          },
        );
        return;
      }
    }
  }
}
