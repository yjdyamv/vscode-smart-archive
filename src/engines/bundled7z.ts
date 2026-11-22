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

/**
 * Resolve the full-format 7-Zip console binary shipped inside the
 * `7zip-zstd-native` dependency (node_modules/7zip-zstd-native/bin/
 * <platform>-<arch>/) for the current platform/arch. On Unix the file may lose
 * its execute bit when the VSIX is unpacked, so restore it. Returns null when
 * no binary matches this platform (→ WASM fallback).
 */
export function bundled7zPath(): string | null {
  // The package lays its binaries out as bin/<platform>-<arch>/7zz(.exe),
  // which is exactly node's process.platform / process.arch — no mapping.
  // Compiled bundle (out/extension.js) resolves from <root>/out; source
  // modules (src/engines, vitest) resolve from <root>/src/engines. Try both.
  const bin = process.platform === "win32" ? "7zz.exe" : "7zz";
  const rel = path.join(
    "node_modules",
    "7zip-zstd-native",
    "bin",
    `${process.platform}-${process.arch}`,
    bin,
  );
  const candidates = [path.join(__dirname, "..", rel), path.join(__dirname, "..", "..", rel)];
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
  if (!testBinary(p)) {
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
