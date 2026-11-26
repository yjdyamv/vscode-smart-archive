/**
 * Compress command handler — Smart Archiver VSCode Extension
 *
 * Orchestrates the compression workflow:
 *   format → level → volume → password → save → execute
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
  DEFAULT_COMPRESSION_LEVEL,
  lookupFormat,
  resolveCompressFormats,
} from "../constants";
import { resolveSaveName } from "../utils/path";
import { getVolumeSizes } from "../utils/volume-sizes";
import { parseSize } from "../utils/security";
import {
  normalizeNumericInput,
  parseVolumeSizeInput,
  promptSavePath,
  promptValuePick,
  registerPasswordToggle,
} from "../ui/prompts";
import type { StepResult, ValuePickRow } from "../ui/prompts";
import type { CompressOptions, FormatInfo } from "../types";
import { normalizeSevenZipMethod } from "../utils/sevenZipMethod";
import { t, compressLevels, formatDuration, formatCompactSize } from "../i18n";
import { logger } from "../utils/logger";
import { isCancellationError } from "../utils/cancellation";
import { StageProgress, type ProgressStage, type StageDuration } from "../ui/stage-progress";

// ── Shared helpers for back-navigable QuickPick / InputBox ──

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
    const isPw = !!opts.password;
    const paintButtons = (): void => {
      ib.buttons = shown
        ? [eyeOffBtn, clearBtn, vscode.QuickInputButtons.Back]
        : [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
    };
    const toggle = (): void => {
      shown = !shown;
      ib.password = !shown;
      paintButtons();
    };
    ib.prompt = opts.prompt;
    ib.placeholder = opts.placeholder;
    ib.value = opts.value ?? "";
    ib.password = isPw;
    ib.ignoreFocusOut = true;
    // Both password boxes get the eye: during a long hand-typed password the
    // confirmation field is exactly where you want to see what you typed.
    ib.buttons = isPw
      ? [eyeBtn, clearBtn, vscode.QuickInputButtons.Back]
      : [clearBtn, vscode.QuickInputButtons.Back];
    const own = isPw ? registerPasswordToggle(toggle) : undefined;
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
        toggle();
      } else if (b === vscode.QuickInputButtons.Back) {
        result = "back";
        ib.hide();
      }
    });
    ib.onDidHide(() => {
      if (own) own();
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
  const config = vscode.workspace.getConfiguration("smart-archiver");
  const defaultFormat = config.get<string>("default.format", "7z");
  const formatOrder = config.get<string[]>("default.formatOrder", []);
  const items = resolveCompressFormats(formatOrder, defaultFormat).map((f) => ({
    label: f.label,
    description: f.description,
  }));
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
  const config = vscode.workspace.getConfiguration("smart-archiver");
  const defaultLevel = config.get<number>("default.compressionLevel", DEFAULT_COMPRESSION_LEVEL);
  const labels = compressLevels();
  const defaultIdx = LEVEL_VALUES.indexOf(defaultLevel);
  const order = LEVEL_VALUES.map((_, i) => i);
  if (defaultIdx >= 0) {
    // Default first, so an empty Enter is "take the default".
    order.splice(defaultIdx, 1);
    order.unshift(defaultIdx);
  }
  return promptValuePick<number>({
    items: order.map((i) => ({ label: labels[i], value: LEVEL_VALUES[i] })),
    placeHolder: t("compress.selectLevel"),
    title: t("wizard.step.level"),
    // Any level 0-9, not only the six presets: 2/4/6/8 are otherwise
    // unreachable, and they are exactly what "a bit faster than Normal" means.
    parse: (raw) => {
      const s = normalizeNumericInput(raw);
      if (!/^\d{1,2}$/.test(s)) return undefined;
      const n = Number(s);
      return n <= 9 ? n : undefined;
    },
    describe: (v) => t("wizard.inputUseLevel", String(v)),
    invalid: (raw) => t("wizard.inputInvalidLevel", raw),
  });
}

async function promptVolumeWizard(): Promise<StepResult<string | undefined>> {
  // "" is this step's spelling of "don't split": the picker's first row. Keeping
  // the value type `string` means the typed-value row never has to explain an
  // undefined, and the wizard state below maps "" back to "no volumes".
  const res = await promptValuePick<string>({
    items: [
      // First row = empty Enter = don't split.
      { label: t("compress.volume.none"), value: "" },
      ...getVolumeSizes().map((v) => ({
        label: v.label,
        value: v.value,
        description: v.description,
      })),
    ],
    placeHolder: t("compress.volume.hint"),
    title: t("wizard.step.volume"),
    parse: parseVolumeSizeInput,
    // Show the size the typed value actually resolves to, so "1.1m" and
    // "1.5 GB" are confirmed in the unit the archiver uses.
    describe: (v) => t("wizard.inputUseSize", v, formatCompactSize(parseSize(v, 0))),
    invalid: (raw) => t("wizard.inputInvalidSize", raw),
  });
  if (res.kind !== "ok") return res;
  return { kind: "ok", value: res.value === "" ? undefined : res.value };
}

/**
 * The encryption step is the password box itself — there is no yes/no question
 * in front of it. Typing a password encrypts, leaving it empty (a bare Enter)
 * skips encryption, so the ordinary "I don't want encryption" path is one
 * keystroke and never a menu.
 *
 * A non-empty password is asked twice: one box is a trap, because a single
 * typo produces an archive nobody can open and nothing in the flow ever shows
 * what was typed. A mismatch goes back to the first box instead of failing
 * the step.
 */
async function promptPasswordWizard(): Promise<StepResult<string>> {
  for (;;) {
    const first = await promptInputBox({
      prompt: t("password.setPrompt"),
      placeholder: t("password.encryptHint"),
      password: true,
    });
    if (first.kind !== "ok") return first;
    // Blank = no encryption. Return early so nobody is asked to confirm it.
    if (first.value.length === 0) return { kind: "ok", value: "" };
    const again = await promptInputBox({
      prompt: t("password.confirmPrompt"),
      placeholder: t("password.confirmHint"),
      password: true,
      validate: (v) => (v.length > 0 ? undefined : t("password.empty")),
    });
    // Back from the confirmation re-opens the first box: the typo may be in
    // either one, so neither is assumed correct.
    if (again.kind === "back") continue;
    if (again.kind !== "ok") return again;
    if (again.value === first.value) return { kind: "ok", value: first.value };
    vscode.window.showWarningMessage(t("password.mismatch"));
  }
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
  const visited = new Set<string>();
  const walk = (p: string): void => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    // Never follow symlinks: a link loop (or a junction cycle) would recurse
    // without bound and overflow the stack before compression even starts.
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let real: string;
      try {
        real = fs.realpathSync(p);
      } catch {
        return;
      }
      if (visited.has(real)) return;
      visited.add(real);
      let children: string[];
      try {
        children = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const child of children) walk(path.join(p, child));
    } else if (st.isFile()) {
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

  let step = 1; // 1=format, 2=level, 3=volume, 4=password, 56=recovery record, 57=recovery volumes, 6=save

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

      // ── 4. Password (this *is* the encryption step) ──
      case 4: {
        if (!format!.supportsEncryption) {
          // RAR still supports a recovery record without encryption.
          step = format!.label === "rar" ? 56 : 6;
          continue;
        }
        const r = await promptPasswordWizard();
        if (r.kind !== "ok") {
          if (r.kind === "back") {
            step = ["7z", "zip", "rar"].includes(format!.label) ? 3 : 2;
            continue;
          }
          return;
        }
        password = r.value;
        doEncrypt = password.length > 0;
        // RAR header encryption is forced: hiding contents while leaving
        // the file names visible defeats the purpose.
        encryptHeaders = doEncrypt;
        step = format!.label === "rar" ? 56 : 6;
        continue;
      }

      // ── 5.6 Inline recovery record (RAR only) ──
      case 56: {
        // Percent of the archive size. For a split archive the binding writes
        // one record per volume, each protecting that volume's own prefix
        // (WinRAR -rr with -v), so the wording says "per volume" and the
        // per-volume cost is known and shown.
        const split = Boolean(volumeSize);
        const title = split ? t("recovery.splitTitle") : t("recovery.title");
        const perVolumeSize = volumeSize ? parseSize(volumeSize, 0) : 0;
        const percentItem = (p: number) => ({
          label: split
            ? t("recovery.percentPerVolume", String(p))
            : t("recovery.percent", String(p)),
          value: p,
          description: split
            ? t("recovery.percentCost", formatCompactSize((perVolumeSize * p) / 100))
            : undefined,
        });
        const items = [{ label: t("recovery.none"), value: 0 }, ...[1, 3, 5, 10].map(percentItem)];
        // "7" and "7%" both mean 7; 0 means no record, like the first row.
        const res = await promptValuePick<number>({
          items,
          placeHolder: title,
          title,
          parse: (raw) => {
            const s = normalizeNumericInput(raw);
            if (!/^\d{1,3}%?$/.test(s)) return undefined;
            const n = Number(s.replace("%", ""));
            return n <= 100 ? n : undefined;
          },
          describe: (p) => percentItem(p).label,
          invalid: (raw) => t("wizard.inputInvalidPercent", raw),
        });
        if (res.kind !== "ok") {
          if (res.kind === "back") {
            step = 4;
            continue;
          }
          return;
        }
        recoveryPercent = res.value;
        step = volumeSize ? 57 : 6;
        continue;
      }

      // ── 5.7 Recovery volumes (split RAR only) ──
      case 57: {
        if (!volumeSize) {
          step = 6;
          continue;
        }
        // .rev volumes: an exact count, like WinRAR -rv<N>. Percent-based
        // sizing (-rv<N%>) is gone — a count is what people reason about
        // ("one spare volume"), and it does not silently rescale when the
        // input compresses better or worse than estimated.
        //
        // The ceiling is the data-volume count, not a round number: a .rev set
        // bigger than the volumes it protects cannot be used for anything, and
        // a typed 1000 next to 3 data volumes is a typo, not a plan.
        const estimatedVolumes = estimateVolumeCount(targets, volumeSize);
        const perVolumeSize = parseSize(volumeSize, 0);
        const maxCount = Math.max(1, estimatedVolumes);
        const countItem = (n: number): ValuePickRow<number> => ({
          label: t("recovery.volumesCount", String(n)),
          value: n,
          description: [
            t("recovery.volumesRepairs", String(n)),
            t("recovery.volumesCost", formatCompactSize(perVolumeSize * n)),
          ].join(" · "),
        });
        const items: ValuePickRow<number>[] = [
          { label: t("recovery.none"), value: 0 },
          ...[1, 2, 3, 5, 10].filter((n) => n <= maxCount).map(countItem),
        ];
        const res = await promptValuePick<number>({
          items,
          placeHolder: t("recovery.volumesTitle", String(estimatedVolumes)),
          title: t("recovery.volumesTitle", String(estimatedVolumes)),
          parse: (raw) => {
            const s = normalizeNumericInput(raw);
            if (!/^\d+$/.test(s)) return undefined;
            const n = Number(s);
            return n === 0 ? 0 : Math.min(n, maxCount);
          },
          describe: (n, raw) =>
            n === 0
              ? t("recovery.none")
              : Number(normalizeNumericInput(raw)) > n
                ? t("recovery.volumesUseCountCapped", String(n), String(maxCount))
                : t("recovery.volumesUseCount", String(n)),
          invalid: (raw) => t("wizard.inputInvalidRevCount", raw, String(maxCount)),
        });
        if (res.kind !== "ok") {
          if (res.kind === "back") {
            step = 56;
            continue;
          }
          return;
        }
        recoveryVolumeCount = res.value;
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
              step =
                format!.label === "rar"
                  ? volumeSize
                    ? 57
                    : 56
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
              .getConfiguration("smart-archiver")
              .get<string>("compression.method", "flzma2"),
          ),
          // 7z and RAR5 honor the solid toggle; the other formats have no
          // solid mode (zip/tar compress per file, tar-family is one file).
          solid:
            format!.label === "7z" || format!.label === "rar"
              ? vscode.workspace
                  .getConfiguration("smart-archiver")
                  .get<boolean>("compression.solid", false)
              : undefined,
        };

        const excludePatterns: string[] =
          vscode.workspace
            .getConfiguration("smart-archiver")
            .get<string[]>("patterns.compressExclude") ?? COMPRESS_EXCLUDE_DEFAULTS;
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
