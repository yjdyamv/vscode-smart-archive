/**
 * Shared utilities for webview message handlers.
 *
 * @module providers/webview/handlers/shared
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawnCapture, system7zForExt } from "../../../engines/system7z";
import { validatePassword } from "../../../utils/security";
import {
  getFullExt,
  COMPRESS_FORMATS,
  removeVolumeSuffix,
  PASSWORD_VERIFY_TIMEOUT_MS,
} from "../../../constants";
import { getVolumeSizes, toBinaryVolumeSize } from "../../../utils/volume-sizes";
import { logger } from "../../../utils/logger";
import { t } from "../../../i18n";
import type { ListEntry } from "../../../engines/fileListing-core";
import { isPasswordOrEncryptError } from "../../../utils/errorClassifier";
import { uniquePath } from "../helpers";
import { registerPasswordToggle } from "../../../ui/prompts";

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
    ib.prompt = prompt;
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
        toggle();
      } else {
        ib.hide();
        resolve(undefined);
      }
    });
    ib.onDidHide(() => {
      release();
      // Only cancel when the box closed without an accept. The accept path
      // already resolved with the value (hide() may fire this event before
      // the rest of the accept handler runs — resolving here would silently
      // turn every confirmed password into undefined).
      if (accepted) return;
      logger.debug({ event: "shared.pwInputBox.cancelled" });
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

/**
 * Destination for merging a split-volume set back into a single archive.
 *
 * The base name is the normal target (archive.7z.001 → archive.7z). Two
 * special cases:
 *   - A .rNN set redirects the webview to the set's base file itself
 *     (archive.rar), so the target IS the current file — replacing the first
 *     volume with a single archive is the merge intent, not a collision.
 *   - Any other existing target must not be silently overwritten (or, with
 *     the system-7z engine, merged into) — uniquify like encrypt/decrypt do.
 */
export function mergeOutputPath(filePath: string, fmt: string): string {
  const dst = getSplitVolumeStem(filePath) + "." + fmt;
  return dst === filePath ? dst : uniquePath(dst);
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

/** How long the probe may take before we give up and accept the password. */
const PASSWORD_PROBE_TIMEOUT_MS = 8_000;

/**
 * Decrypted bytes that must arrive before the password counts as correct.
 *
 * The cost of a probe is therefore the first block, never the member size:
 * measured 0.15 s for a 200 MB member, where a full `t` of the same member
 * took 1.7 s and a full `t` of a 139 MB multi-volume set took 21 s.
 */
const PASSWORD_PROBE_BYTES = 8 * 1024;

/**
 * Pick the member used to prove a password: the first non-empty file in
 * archive order.
 *
 * Archive order, not size, because archive order is also the decode order: in
 * a solid archive 7z has to decode everything before a member to reach it, so
 * the first member costs one block while the last costs the whole archive.
 * Measured on a solid 7z holding three 30 MB files, prefix reads took 0.17 s /
 * 0.21 s / 0.26 s for the 1st / 2nd / 3rd member. Since only
 * PASSWORD_PROBE_BYTES are read, a huge member costs no more than a tiny one.
 * Names containing wildcard characters are skipped — 7z would treat them as a
 * pattern rather than a literal path.
 */
export function pickPasswordProbe(entries: readonly ListEntry[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "REGULAR_FILE" || e.size <= 0) continue;
    if (/[*?[\]]/.test(e.path) || e.path.startsWith("-")) continue;
    return e.path;
  }
  return undefined;
}

export async function verifyArchivePassword(
  archivePath: string,
  password: string,
  probeEntry?: string,
): Promise<boolean> {
  // Defense-in-depth: a password that fails validation (leading '-', null byte,
  // newline, over-length) can never be the correct one and must not reach argv.
  try {
    validatePassword(password);
  } catch {
    return false;
  }

  // Resolve a format-capable binary: for RAR, some distro 7-Zip builds lack
  // RAR support entirely and would fail the test ("Can't open as archive"),
  // producing a false "wrong password". Prefer the bundled 7zz.
  const sz = system7zForExt(getFullExt(archivePath));
  if (sz) {
    try {
      // With a probe member, stream it to stdout and stop after the first
      // few KB: a wrong password is rejected by 7z from the stored password
      // check before any byte is written, and a correct one is proven by the
      // first decrypted block. Without a probe (nothing extractable), fall
      // back to testing the whole archive.
      // No -p switch: 7z prompts for the password and reads it from stdin,
      // so the secret never appears in the child's argv.
      const { code, stderr, stdout } = probeEntry
        ? await spawnCapture(sz, ["x", "-so", archivePath, probeEntry], {
            timeoutMs: PASSWORD_PROBE_TIMEOUT_MS,
            password,
            stopAfterStdoutBytes: PASSWORD_PROBE_BYTES,
          })
        : await spawnCapture(sz, ["t", archivePath], {
            timeoutMs: PASSWORD_VERIFY_TIMEOUT_MS,
            password,
          });
      // Decrypted bytes are proof: nothing decrypts under a wrong password.
      if (probeEntry && stdout.length > 0) return true;
      // No output at all: a password error is a verdict, anything else (an
      // unreadable member, an unsupported method) is not — accepting is the
      // safer error, since rejecting a correct password locks the user out.
      if (code !== 0 && !isPasswordOrEncryptError(stderr)) return true;
      return code === 0 && !isPasswordOrEncryptError(stderr);
    } catch (err) {
      // Timeout (a huge solid block) or spawn failure: no verdict. Accept the
      // password rather than reject a correct one — a wrong password still
      // surfaces on extract or on the integrity test.
      logger.warn(
        { event: "verifyArchivePassword.inconclusive", err },
        "Password probe was inconclusive, accepting password",
      );
      return true;
    }
  }

  // No system 7z: the WASM build only ever sees one file, so on a
  // multi-volume set it reports a wrong password for every password given,
  // and on a single huge file it costs a full decompression. Neither is a
  // verdict worth having, so accept — extraction and the integrity test still
  // report a wrong password.
  logger.info(
    { event: "verifyArchivePassword.noSystem7z" },
    "No system 7z available, skipping the password probe",
  );
  return true;
}
