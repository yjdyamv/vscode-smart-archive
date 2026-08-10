/**
 * Compress command handler — Smart Archive VSCode Extension
 *
 * Orchestrates the compression workflow:
 *   format → level → volume → encrypt → password → save → execute
 *
 * Each prompt step (except Save) shows a Back button so the user can
 * navigate to the previous step and correct a wrong selection.
 *
 * @module commands/compress
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { compressWith7z } from "../engines/js7z-compress";
import {
  COMPRESS_EXCLUDE_DEFAULTS,
  COMPRESS_FORMATS,
  DEFAULT_COMPRESSION_LEVEL,
  lookupFormat,
} from "../constants";
import { resolveSaveName } from "../utils/path";
import { getVolumeSizes } from "../utils/volume-sizes";
import { parseSize } from "../utils/security";
import { promptSavePath } from "../ui/prompts";
import type { CompressOptions, FormatInfo } from "../types";
import { normalizeSevenZipMethod } from "../utils/sevenZipMethod";
import { t, compressLevels, formatDuration } from "../i18n";
import { logger } from "../utils/logger";
import { isCancellationError } from "../utils/cancellation";
import { StageProgress, type ProgressStage, type StageDuration } from "../ui/stage-progress";

// ── Shared helpers for back-navigable QuickPick / InputBox ──

type StepResult<T> = { kind: "ok"; value: T } | { kind: "back" } | { kind: "cancel" };

function formatStageSummary(durations: StageDuration[]): string {
  if (durations.length < 2) return "";
  const labels: Record<ProgressStage, string> = {
    copy: t("compress.stage.copyShort"),
    pack: t("compress.stage.packShort"),
    compress: t("compress.stage.compressShort"),
    append: t("compress.stage.appendShort"),
  };
  const parts = durations.map(({ stage, ms }) => `${labels[stage]} ${formatDuration(ms)}`);
  return t("compress.stageTimes", parts.join(" · "));
}

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
  value?: string;
  validate?: (v: string) => string | undefined;
}): Promise<StepResult<string>> {
  return new Promise((resolve) => {
    const ib = vscode.window.createInputBox();
    let result: "accept" | "back" | "cancel" | null = null;
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
    const isPw = !!opts.password;
    ib.prompt = opts.prompt;
    ib.placeholder = opts.placeholder;
    ib.value = opts.value ?? "";
    ib.password = isPw;
    ib.ignoreFocusOut = true;
    ib.buttons = isPw
      ? [eyeBtn, clearBtn, vscode.QuickInputButtons.Back]
      : [clearBtn, vscode.QuickInputButtons.Back];
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
        ib.buttons = shown
          ? [eyeOffBtn, clearBtn, vscode.QuickInputButtons.Back]
          : [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
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
  const config = vscode.workspace.getConfiguration("smart-archive");
  const defaultFormat = config.get<string>("defaultFormat", "7z");
  const items = COMPRESS_FORMATS.map((f) => ({ label: f.label, description: f.description }));
  const defaultIdx = items.findIndex((i) => i.label === defaultFormat);
  if (defaultIdx > 0) {
    const [def] = items.splice(defaultIdx, 1);
    items.unshift(def);
  }
  const res = await promptQuickPick(items, {
    placeHolder: t("compress.selectFormat"),
    withBack: false,
    title: t("wizard.step.format"),
  });
  if (res.kind !== "ok") return res;
  return {
    kind: "ok",
    value: lookupFormat(res.value.label),
  };
}

async function promptLevelWizard(): Promise<StepResult<number>> {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const defaultLevel = config.get<number>("defaultCompressionLevel", DEFAULT_COMPRESSION_LEVEL);
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
    title: t("wizard.step.level"),
  });
  if (res.kind !== "ok") return res;
  const idx = labels.indexOf(res.value.label);
  return { kind: "ok", value: idx >= 0 ? LEVEL_VALUES[idx] : defaultLevel };
}

async function promptVolumeWizard(): Promise<StepResult<string | undefined>> {
  const items: { label: string; value: string | undefined; description?: string }[] = [
    { label: t("compress.volume.none"), value: undefined },
    ...getVolumeSizes().map((v) => ({
      label: v.label,
      value: v.value,
      description: v.description,
    })),
    { label: t("compress.volume.custom"), value: "__custom__" },
  ];
  const res = await promptQuickPick(items, {
    placeHolder: t("compress.selectVolume"),
    title: t("wizard.step.volume"),
  });
  if (res.kind !== "ok") return res;
  if (res.value.value === "__custom__") {
    const ibRes = await promptInputBox({
      prompt: t("compress.volume.prompt"),
      placeholder: "100m",
      validate: (v) => {
        const trimmed = v.trim();
        if (!/^\d+[kmg]?$/i.test(trimmed)) return t("compress.volume.invalid");
        const num = parseInt(trimmed, 10);
        if (num <= 0) return t("compress.volume.invalid");
        return undefined;
      },
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
    { placeHolder: t("encrypt.title"), title: t("wizard.step.encrypt") },
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

async function promptSaveNameWizard(defaultName: string, ext: string): Promise<StepResult<string>> {
  const res = await promptInputBox({
    prompt: t("save.namePrompt", ext),
    placeholder: defaultName,
    value: defaultName,
    validate: (v) => {
      if (!v.trim()) return t("validation.nameEmpty");
      if (/[<>:"/\\|?*]/.test(v)) return t("save.nameInvalid");
      return undefined;
    },
  });
  if (res.kind !== "ok") return res;
  return { kind: "ok", value: resolveSaveName(res.value, ext) };
}

// ── Main command ──

/**
 * Rough upper bound of the split-volume count for the given targets:
 * total input bytes ÷ volume size, rounded up. The real count depends on
 * the compression ratio, so this is only shown as an estimate.
 */
function estimateVolumeCount(targets: readonly { fsPath: string }[], volumeSize: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(p)) walk(path.join(p, child));
    } else {
      total += st.size;
    }
  };
  for (const target of targets) walk(target.fsPath);
  const size = parseSize(volumeSize, 0);
  if (size <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

export async function compressCommand(
  uri: vscode.Uri | undefined,
  selectedUris: readonly vscode.Uri[] | undefined,
): Promise<void> {
  let targets: vscode.Uri[];
  let isWorkspaceCompress = false;
  const wsFolders = vscode.workspace.workspaceFolders;

  // Right-clicked on a workspace folder item?
  const matchedWs = uri && wsFolders?.find((f) => f.uri.fsPath === uri.fsPath);

  if (matchedWs) {
    // Right-clicked workspace folder → compress it, save inside
    logger.info({ event: "compress.target.wsFolder", workspacePath: matchedWs.uri.fsPath });
    targets = [matchedWs.uri];
    isWorkspaceCompress = true;
  } else if (!uri && !(selectedUris && selectedUris.length > 0)) {
    // Right-clicked empty space, no selection → compress all workspace folders
    if (!wsFolders || wsFolders.length === 0) {
      logger.warn({ event: "compress.target.noWorkspace" }, "No workspace folders available");
      vscode.window.showErrorMessage(t("compress.noFiles"));
      return;
    }
    logger.info({
      event: "compress.target.emptySpace",
      workspaceCount: wsFolders.length,
      paths: wsFolders.map((f) => f.uri.fsPath),
    });
    targets = wsFolders.map((f) => f.uri);
    isWorkspaceCompress = true;
  } else if (selectedUris && selectedUris.length > 0) {
    logger.info({ event: "compress.target.selection", count: selectedUris.length });
    targets = [...selectedUris];
  } else if (uri) {
    logger.info({ event: "compress.target.single", path: uri.fsPath });
    targets = [uri];
  } else {
    logger.warn({ event: "compress.target.none" }, "No targets available");
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
  let level = DEFAULT_COMPRESSION_LEVEL;
  let volumeSize: string | undefined;
  let doEncrypt = false;
  let password = "";
  let encryptHeaders = false;
  let recoveryPercent = 0;
  let recoveryVolumeCount = 0;

  let step = 1; // 1=format, 2=level, 3=volume, 4=encrypt, 5=password, 56=recovery, 6=save

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

      // ── 2. Level (skip for single-speed codecs) ──
      case 2: {
        const singleSpeed = ["tar.sz", "tar.lz4"].includes(format!.label);
        if (!singleSpeed) {
          const r = await promptLevelWizard();
          if (r.kind !== "ok") {
            if (r.kind === "back") {
              step = 1;
              continue;
            }
            return;
          }
          level = r.value;
        }
        const supSplit = ["7z", "zip", "rar"].includes(format!.label);
        step = supSplit ? 3 : 4; // skip volume if not splittable
        continue;
      }

      // ── 3. Volume size (7z/zip only) ──
      case 3: {
        const r = await promptVolumeWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") {
            step = 2;
            continue;
          }
          return;
        }
        volumeSize = r.value;
        step = 4;
        continue;
      }

      // ── 4. Encryption (if format supports it) ──
      case 4: {
        if (!format!.supportsEncryption) {
          // RAR still supports a recovery record without encryption.
          step = format!.label === "rar" ? 56 : 6;
          continue;
        }
        const r = await promptEncryptWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") {
            step = ["7z", "zip", "rar"].includes(format!.label) ? 3 : 2;
            continue;
          }
          return;
        }
        doEncrypt = r.value;
        if (doEncrypt) {
          // RAR header encryption is forced: hiding contents while leaving
          // the file names visible defeats the purpose.
          encryptHeaders = true;
          step = 5;
        } else {
          step = format!.label === "rar" ? 56 : 6;
        }
        continue;
      }

      // ── 5. Password ──
      case 5: {
        const r = await promptPasswordWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") {
            step = 4;
            continue;
          }
          return;
        }
        password = r.value;
        if (!password) {
          vscode.window.showWarningMessage(t("encrypt.noPassword"));
        }
        step = format!.label === "rar" ? 56 : 6;
        continue;
      }

      // ── 5.6 Recovery record / recovery volumes (RAR only) ──
      case 56: {
        const isSplitRar = format!.label === "rar" && Boolean(volumeSize);
        if (!isSplitRar) {
          // Inline recovery record, percent of archive size.
          const res = await promptQuickPick(
            [
              { label: t("recovery.none"), value: 0 },
              { label: t("recovery.percent", "1"), value: 1 },
              { label: t("recovery.percent", "3"), value: 3 },
              { label: t("recovery.percent", "5"), value: 5 },
              { label: t("recovery.percent", "10"), value: 10 },
              { label: t("recovery.percent", "20"), value: 20 },
            ],
            { placeHolder: t("recovery.title"), title: t("recovery.title") },
          );
          if (res.kind !== "ok") {
            if (res.kind === "back") {
              step = password ? 5 : 4;
              continue;
            }
            return;
          }
          recoveryPercent = res.value.value;
          step = 6;
          continue;
        }

        // Split RAR: recovery volumes (.rev), exact count. The count is
        // capped at the (estimated) volume count; the encoder silently
        // caps it at the actual volume count too.
        const estimatedVolumes = estimateVolumeCount(targets, volumeSize!);
        const maxFixed = Math.min(10, estimatedVolumes);
        const items: { label: string; value: number; description?: string }[] = [
          { label: t("recovery.none"), value: 0 },
          ...Array.from({ length: maxFixed }, (_, i) => ({
            label: t("recovery.volumesCount", String(i + 1)),
            value: i + 1,
          })),
          { label: t("recovery.volumesCustom"), value: -1 },
        ];
        const res = await promptQuickPick(items, {
          placeHolder: t("recovery.volumesTitle", String(estimatedVolumes)),
          title: t("recovery.volumesTitle", String(estimatedVolumes)),
        });
        if (res.kind !== "ok") {
          if (res.kind === "back") {
            step = password ? 5 : 4;
            continue;
          }
          return;
        }
        if (res.value.value === -1) {
          const ibRes = await promptInputBox({
            prompt: t("recovery.volumesCustomPrompt"),
            placeholder: String(Math.min(estimatedVolumes, 10)),
            validate: (v) => {
              const num = parseInt(v.trim(), 10);
              if (!/^\d+$/.test(v.trim()) || num < 1 || num > 1000) {
                return t("recovery.volumesInvalid");
              }
              return undefined;
            },
          });
          if (ibRes.kind !== "ok") {
            if (ibRes.kind === "back") {
              continue; // re-ask the count list
            }
            return;
          }
          recoveryVolumeCount = parseInt(ibRes.value, 10);
        } else {
          recoveryVolumeCount = res.value.value;
        }
        step = 6;
        continue;
      }

      // ── 6. Save & compress ──
      case 6: {
        const firstTarget = targets[0];
        const ext = format!.label;

        let outputPath: string;

        if (volumeSize) {
          const defaultName = targets.length === 1 ? path.basename(firstTarget.fsPath) : "archive";
          const r = await promptSaveNameWizard(defaultName, ext);
          if (r.kind !== "ok") {
            if (r.kind === "back") {
              step = doEncrypt
                ? 5
                : format!.label === "rar"
                  ? 56
                  : format!.supportsEncryption
                    ? 4
                    : 3;
              continue;
            }
            return;
          }
          const baseName = r.value;
          const dir = isWorkspaceCompress ? firstTarget.fsPath : path.dirname(firstTarget.fsPath);
          const folderName =
            targets.length === 1
              ? path.basename(firstTarget.fsPath)
              : baseName.replace(/\.[^.]+$/, "");
          let folderPath = path.join(dir, folderName);
          if (fs.existsSync(folderPath)) {
            let i = 1;
            while (fs.existsSync(path.join(dir, `${folderName}_${i}`))) i++;
            folderPath = path.join(dir, `${folderName}_${i}`);
          }
          outputPath = path.join(folderPath, baseName);
        } else {
          logger.info({
            event: "compress.saveDialog",
            isWorkspaceCompress,
            firstTarget: firstTarget.fsPath,
            targetsLen: targets.length,
            saveDir: isWorkspaceCompress ? firstTarget.fsPath : path.dirname(firstTarget.fsPath),
          });
          const saveUri = await promptSavePath(
            firstTarget.fsPath,
            targets.length,
            ext,
            isWorkspaceCompress ? firstTarget.fsPath : undefined,
          );
          if (!saveUri) {
            logger.info({ event: "compress.cancelled", step: "save" });
            return;
          }
          logger.info({ event: "compress.chosen", outputPath: saveUri.fsPath });
          outputPath = saveUri.fsPath;
        }

        const options: CompressOptions = {
          targets: targets.map((target) => ({ fsPath: target.fsPath })),
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
          encryptHeaders,
          recoveryPercent,
          recoveryVolumeCount,
          sevenZipMethod: normalizeSevenZipMethod(
            vscode.workspace
              .getConfiguration("smart-archive")
              .get<string>("sevenZipMethod", "flzma2"),
          ),
        };

        const excludePatterns: string[] =
          vscode.workspace
            .getConfiguration("smart-archive")
            .get<string[]>("compressExcludePatterns") ?? COMPRESS_EXCLUDE_DEFAULTS;
        const startTime = Date.now();
        const stages = new StageProgress();
        let error: unknown;
        try {
          await compressWith7z(options, stages.progress, stages.token, excludePatterns);
        } catch (err) {
          error = err;
        } finally {
          await stages.dispose();
        }

        if (error) {
          logger.error({ event: "compress.command.failed", err: error }, "Compression failed");
          try {
            if (fs.existsSync(options.outputPath)) fs.unlinkSync(options.outputPath);
          } catch {
            logger.warn(
              { event: "compress.cleanup.failed" },
              "Failed to clean up partial output file",
            );
          }
          if (!isCancellationError(error)) {
            vscode.window.showErrorMessage(t("compress.failed") + (error as Error).message);
          }
        } else {
          logger.info({ event: "compress.command.done", outputPath: options.outputPath });
          vscode.window.showInformationMessage(
            t("compress.done") +
              options.outputPath +
              t("time.elapsed", formatDuration(Date.now() - startTime)) +
              formatStageSummary(stages.stageDurations()),
          );
        }
        return;
      }
    }
  }
}
