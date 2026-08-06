/**
 * Bundled 7-Zip binary resolution — vscode-free.
 *
 * Used by both the system7z engine (host) and the codec native fast path
 * (worker threads). Must never import `vscode`: worker bundles load this
 * module outside the extension host.
 *
 * @module engines/bundled7z
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { BINARY_DETECT_TIMEOUT } from "../constants";
import { logger } from "../utils/logger-core";

/** Minimum 7-Zip version required (v21+ covers all non-zstd operations) */
export const MIN_VERSION = 21;
/** Zstd decompression requires v24+ */
export const MIN_VERSION_ZSTD = 24;

/**
 * Resolve the full-format 7-Zip console binary bundled under vendor/7z-bin/ for the
 * current platform/arch (staged by scripts/install-7z-platforms.js). On Unix
 * the file may lose its execute bit when the VSIX is unpacked, so restore it.
 * Returns null when no binary is bundled for this platform (→ WASM fallback).
 */
export function bundled7zPath(): string | null {
  // Compiled bundle (out/extension.js) resolves from <root>/out; source
  // modules (src/engines, vitest) resolve from <root>/src/engines. Try both.
  // All platforms use the same `7zz` name (Windows: 7zz.exe); the 7z.exe
  // fallback only covers stale vendor dirs from older staging runs.
  const names = process.platform === "win32" ? ["7zz.exe", "7z.exe"] : ["7zz"];
  const candidates = names.flatMap((bin) => {
    const rel = path.join("vendor", "7z-bin", process.platform, process.arch, bin);
    return [path.join(__dirname, "..", rel), path.join(__dirname, "..", "..", rel)];
  });
  const p = candidates.find((c) => fs.existsSync(c)) ?? null;
  if (!p) return null;
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(p, 0o755);
    } catch (err) {
      logger.warn({ event: "system7z.bundled.chmodFailed", err });
    }
  }
  if (process.platform === "darwin") prepareMacBundledBinary(p);
  // Confirm it can actually execute here before handing it out. A read-only or
  // `noexec` extensions dir, an ownership/permission issue (system-wide or
  // root-installed VS Code, Nix store), SELinux/AppArmor, or a wrong arch/libc
  // build all make the binary unrunnable — in which case return null so
  // detection falls back to WASM instead of "detecting" a binary that would
  // only fail at spawn time. (mac prep above must run first, or this test spawn
  // could itself be Gatekeeper-blocked.)
  if (!testBinary(p) || !versionOk(p)) {
    logger.warn({ event: "system7z.bundled.notRunnable", path: p });
    return null;
  }
  return p;
}

let _macPrepared = false;

/**
 * Make the bundled macOS 7zz runnable without a Gatekeeper prompt — silent and
 * entirely user-level (the file lives in the user-owned extension dir, so no
 * admin/sudo is ever needed). Runs once per session, best-effort (never throws):
 *   1. Strip the com.apple.quarantine attribute so Gatekeeper won't block the
 *      spawned binary.
 *   2. Only if the binary has NO valid signature (unsigned/invalid), apply a
 *      free ad-hoc signature — an unsigned arm64 binary is SIGKILLed on Apple
 *      Silicon. The official 7zz is already Developer-ID signed, so this is
 *      normally a no-op; we never overwrite a valid signature.
 */
function prepareMacBundledBinary(p: string): void {
  if (_macPrepared) return;
  _macPrepared = true;
  try {
    // -d on a missing attr just errors out harmlessly; ignore the result.
    spawnSync("xattr", ["-d", "com.apple.quarantine", p], { stdio: "ignore", timeout: 5000 });
  } catch (err) {
    logger.debug({ event: "system7z.bundled.xattrFailed", err });
  }
  try {
    const verify = spawnSync("codesign", ["--verify", "--no-strict", p], {
      stdio: "ignore",
      timeout: 8000,
    });
    if (verify.status !== 0) {
      logger.info({ event: "system7z.bundled.adhocSign", path: p });
      spawnSync("codesign", ["--sign", "-", "--force", p], { stdio: "ignore", timeout: 15000 });
    }
  } catch (err) {
    logger.debug({ event: "system7z.bundled.codesignFailed", err });
  }
}

export function resetBundledMacPrep(): void {
  _macPrepared = false;
}

export function testBinary(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, [], {
      stdio: "pipe",
      timeout: BINARY_DETECT_TIMEOUT,
      windowsHide: true,
    });
    return result.status === 0;
  } catch (err) {
    logger.warn(
      { event: "system7z.testBinary.failed", path: binaryPath, err },
      "Failed to test 7z binary",
    );
    return false;
  }
}

/** Quick version check during detection — no shared cache pollution */
export function versionOk(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, [], {
      stdio: "pipe",
      timeout: BINARY_DETECT_TIMEOUT,
      windowsHide: true,
    });
    const output = result.stdout.toString();
    const m = output.match(/7-Zip\s+(?:\(z\)\s+)?(\d+)\.(\d+)/i);
    if (m) {
      const ver = parseInt(m[1], 10) + parseInt(m[2], 10) / 100;
      const ok = ver >= MIN_VERSION;
      logger.info({
        event: "system7z.detect.version",
        path: binaryPath,
        platform: process.platform,
        raw: m[0],
        version: ver,
        minRequired: MIN_VERSION,
        ok,
      });
      return ok;
    }
    logger.warn({
      event: "system7z.detect.unparseable",
      path: binaryPath,
      platform: process.platform,
      output: output.slice(0, 80),
    });
    return false;
  } catch (err) {
    logger.warn({
      event: "system7z.detect.error",
      path: binaryPath,
      platform: process.platform,
      err,
    });
    return false;
  }
}
