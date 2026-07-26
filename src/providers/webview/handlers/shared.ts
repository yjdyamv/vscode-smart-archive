/**
 * Shared utilities for webview message handlers.
 *
 * @module providers/webview/handlers/shared
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawnCapture, detectSystem7z } from "../../../engines/system7z";
import { validatePassword } from "../../../utils/security";
import { getFullExt, COMPRESS_FORMATS, removeVolumeSuffix } from "../../../constants";
import { getVolumeSizes, toBinaryVolumeSize } from "../../../utils/volume-sizes";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import { JS7z, disposeJS7z } from "../../fileListing";
import { streamToVFS } from "../../../engines/vfs-io";

export function pwInputBox(
  prompt: string,
  validate?: (v: string) => string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const ib = vscode.window.createInputBox();
    let shown = false;
    let accepted = false;
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
    ib.prompt = prompt;
    ib.password = true;
    ib.ignoreFocusOut = true;
    ib.buttons = [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
    if (validate) {
      ib.onDidChangeValue((v) => {
        ib.validationMessage = validate(v) ?? "";
      });
    }
    ib.onDidAccept(() => {
      if (validate && validate(ib.value)) return;
      const val = ib.value;
      accepted = true;
      ib.hide();
      resolve(val);
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
        resolve(undefined);
      }
    });
    ib.onDidHide(() => {
      if (!accepted) {
        logger.debug({ event: "pwInputBox.cancelled" });
      }
      resolve(undefined);
    });
    ib.show();
  });
}

export async function promptConvertFormat(): Promise<string | undefined> {
  const formats = COMPRESS_FORMATS.filter((f) => f.canCreate);
  const chosen = await vscode.window.showQuickPick(
    formats.map((f) => ({ label: f.label, description: f.description })),
    { placeHolder: t("compress.selectTargetFormat"), ignoreFocusOut: true },
  );
  return chosen?.label;
}

export async function resolveWritableFormat(fmt: string): Promise<string | undefined> {
  if (COMPRESS_FORMATS.some((f) => f.label === fmt)) return fmt;
  const choice = await vscode.window.showWarningMessage(
    t("compress.rarUnsupported"),
    { modal: true },
    "7z",
    "zip",
  );
  return choice;
}

export function getSplitVolumeStem(filePath: string): string {
  const m = filePath.match(/^(.+)\.part\d+\.rar$/i);
  if (m) return m[1];
  const m2 = filePath.match(/^(.+)\.r\d{2}$/i);
  if (m2) return m2[1];
  const ext = getFullExt(filePath);
  return removeVolumeSuffix(filePath).slice(0, -ext.length);
}

export function getSplitOutputPath(
  filePath: string,
  fmt: string,
  suffix: string,
): { dst: string; folder: string } {
  const base = getSplitVolumeStem(filePath);
  const baseName = path.basename(base);
  const dir = path.dirname(filePath);
  let folder = path.join(dir, baseName + suffix);
  if (fs.existsSync(folder)) {
    let i = 1;
    while (fs.existsSync(path.join(dir, `${baseName}${suffix}_${i}`))) i++;
    folder = path.join(dir, `${baseName}${suffix}_${i}`);
  }
  return { dst: path.join(folder, baseName + "." + fmt), folder };
}

export function detectVolumeSize(filePath: string): string | undefined {
  const ext = getFullExt(filePath);
  const base = getSplitVolumeStem(filePath);

  let firstVol: string;
  if (/\.part\d+\.rar$/i.test(filePath)) {
    firstVol = base + ".part1" + ext;
  } else if (/\.r\d{2}$/i.test(filePath)) {
    firstVol = base + ".r00";
  } else {
    firstVol = base + ext + ".001";
  }

  if (!fs.existsSync(firstVol)) return undefined;

  const bytes = fs.statSync(firstVol).size;
  const UNIT_BYTES = { g: 1073741824, m: 1048576, k: 1024 } as const;

  for (const preset of getVolumeSizes()) {
    const v = toBinaryVolumeSize(preset.value);
    const unit = v.slice(-1).toLowerCase() as keyof typeof UNIT_BYTES;
    const num = parseInt(v.slice(0, -1), 10);
    const targetBytes = num * (UNIT_BYTES[unit] || 1);
    const ratio = bytes / targetBytes;
    if (ratio > 0.9 && ratio < 1.1) return preset.value;
  }

  if (bytes >= UNIT_BYTES.g * 0.8) return Math.round(bytes / UNIT_BYTES.g) + "g";
  if (bytes >= UNIT_BYTES.m * 0.8) return Math.round(bytes / UNIT_BYTES.m) + "m";
  return Math.round(bytes / UNIT_BYTES.k) + "k";
}

export async function verifyArchivePassword(
  archivePath: string,
  password: string,
): Promise<boolean> {
  // Defense-in-depth: a password that fails validation (leading '-', null byte,
  // newline, over-length) can never be the correct one and must not reach argv.
  try {
    validatePassword(password);
  } catch {
    return false;
  }

  const sz = detectSystem7z();
  if (sz) {
    try {
      const { code } = await spawnCapture(sz, ["t", `-p${password}`, archivePath], 15_000);
      return code === 0;
    } catch (err) {
      logger.warn(
        { event: "verifyArchivePassword.system7z.failed", err },
        "System 7z password verification failed, falling back to WASM",
      );
    }
  }

  try {
    const js7z = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      const archiveFsPath = streamToVFS(js7z, archivePath);
      let ok = false;
      await new Promise<void>((resolve) => {
        js7z.onExit = (c: number) => {
          ok = c === 0;
          resolve();
        };
        js7z.callMain(["t", archiveFsPath, `-p${password}`]);
      });
      return ok;
    } finally {
      disposeJS7z(js7z);
    }
  } catch (err) {
    // WASM init, VFS load, or 7z t failed — we cannot verify the
    // password. Treat as invalid rather than silently accepting it.
    logger.warn(
      { event: "verifyArchivePassword.wasm.failed", err },
      "WASM password verification failed, rejecting password",
    );
    return false;
  }
}
