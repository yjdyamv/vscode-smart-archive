/**
 * System 7-Zip engine — Smart Archive VSCode Extension
 *
 * Detects a local 7-Zip installation and uses it for
 * compress/decompress/list operations with better performance
 * than the bundled js7z-tools WASM engine.
 *
 * Falls back to js7z-tools when no system 7-Zip is found.
 *
 * Cross-platform notes:
 *   - Windows: code page may be CP936/CP932/CP65001 etc. stderr is decoded
 *     accordingly; system 7z lists without -sccUTF-8 so output matches the
 *     detected code page and fixArchiveEncoding handles legacy CJK filenames
 *   - Linux/macOS: UTF-8 by default, no special handling needed
 *   - 7z exit codes: 0=ok, 1=warning (non-fatal, e.g. permissions),
 *     2=fatal, 7=bad args, 8=OOM, 255=user interrupt
 *
 * @module engines/system7z
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, spawnSync } from "child_process";
import * as vscode from "vscode";
import type { TokenLike, ProgressLike } from "../utils/cancellation";
import * as iconv from "iconv-lite";
import type { CompressOptions, DecompressOptions } from "../types";
import { t } from "../i18n";
import { logger } from "../utils/logger";
import { isPasswordOrEncryptError } from "../utils/errorClassifier";
import { validatePassword, checkFileSize, sanitizeCliPath } from "../utils/security";
import { parse7zListing } from "../utils/parse7z";
import { getBaseName } from "../utils/path";
import { BINARY_DETECT_TIMEOUT, RUN7Z_TIMEOUT, SPAWN_CAPTURE_TIMEOUT, getFullExt } from "../constants";
import { toBinaryVolumeSize } from "../utils/volume-sizes";
import { prepareExclusions, isTargetExcluded, isPathExcluded } from "../utils/exclude";
import type { ExclusionSet } from "../utils/exclude";
import { checkArchiveInputSize, calcSplitVolumeTotalSize } from "./vfs-io";
import { checkTotalSize } from "../utils/security";
import { createTarFile } from "./tar-writer";
import { isRarExt } from "../utils/rar";

// ── Detection (cached) ───────────────────────────────────────────────

let _cachedPath: string | null | undefined;

/**
 * Detect a system-installed 7-Zip binary.
 * Searches known paths first, then PATH. Result is cached.
 */
export function detectSystem7z(): string | null {
  if (_cachedPath !== undefined) return _cachedPath;

  const setting = vscode.workspace
    .getConfiguration("smart-archive")
    .get<string>("useSystem7z", "auto");

  // "bundled": skip system detection entirely and force the VSIX-bundled 7zz
  // (→ null / WASM when it is missing or cannot run on this platform).
  if (setting === "bundled") {
    _cachedPath = bundled7zPath();
    logger.info({
      event: _cachedPath ? "system7z.detected" : "system7z.notFound",
      path: _cachedPath ?? undefined,
      method: "bundled-forced",
      platform: process.platform,
    });
    return _cachedPath;
  }

  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push("C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe");
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, "Programs", "7-Zip", "7z.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/usr/local/bin/7z",
      "/usr/local/bin/7zz",
      "/opt/homebrew/bin/7z",
      "/opt/homebrew/bin/7zz",
    );
  } else {
    candidates.push("/usr/bin/7z", "/usr/local/bin/7z", "/usr/bin/7zz", "/usr/local/bin/7zz");
  }

  for (const c of candidates) {
    if (fs.existsSync(c) && testBinary(c)) {
      // Check version before accepting — skip old p7zip if newer 7z/7zz is also present
      if (!versionOk(c)) continue;
      _cachedPath = c;
      logger.info({ event: "system7z.detected", path: c, method: "known-path" });
      return _cachedPath;
    }
  }

  const names =
    process.platform === "win32" ? ["7z.exe", "7za.exe", "7zz.exe"] : ["7z", "7za", "7zz"];
  for (const name of names) {
    const found = resolveFromPath(name);
    if (found && testBinary(found) && versionOk(found)) {
      _cachedPath = found;
      logger.info({ event: "system7z.detected", path: found, method: "PATH" });
      return _cachedPath;
    }
  }

  // Fall back to the 7-Zip binary bundled in the VSIX (guarantees availability
  // even when nothing is installed). A user-installed 7z is preferred above.
  const bundled = bundled7zPath();
  if (bundled) {
    _cachedPath = bundled;
    logger.info({ event: "system7z.detected", path: bundled, method: "bundled" });
    return _cachedPath;
  }

  _cachedPath = null;
  logger.info({ event: "system7z.notFound", platform: process.platform });
  return null;
}

/**
 * Resolve the full-format 7-Zip console binary bundled under 7z-bin/ for the
 * current platform/arch (staged by scripts/install-7z-platforms.js). On Unix
 * the file may lose its execute bit when the VSIX is unpacked, so restore it.
 * Returns null when no binary is bundled for this platform (→ WASM fallback).
 */
function bundled7zPath(): string | null {
  const bin = process.platform === "win32" ? "7z.exe" : "7zz";
  const rel = path.join("7z-bin", process.platform, process.arch, bin);
  // Compiled bundle (out/extension.js) resolves from <root>/out; source
  // modules (src/engines, vitest) resolve from <root>/src/engines. Try both.
  const p =
    [path.join(__dirname, "..", rel), path.join(__dirname, "..", "..", rel)].find((c) =>
      fs.existsSync(c),
    ) ?? null;
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

export function hasSystem7z(): boolean {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const setting = config.get<string>("useSystem7z", "auto");

  if (setting === "never") {
    logger.debug({ event: "system7z.disabledBySetting" });
    return false;
  }

  const sz = detectSystem7z();
  if (!sz) {
    if (setting === "always") {
      vscode.window.showWarningMessage(t("system7z.notInstalled"));
    }
    return false;
  }

  if (!checkVersion(sz)) {
    if (setting === "always") {
      vscode.window.showWarningMessage(t("system7z.tooOld"));
    }
    return false;
  }

  return true;
}

/** Minimum 7-Zip version required (v21+ covers all non-zstd operations) */
const MIN_VERSION = 21;
/** Zstd decompression requires v24+ */
const MIN_VERSION_ZSTD = 24;

let _cachedVersion: number | undefined;

/**
 * Reset the cached engine detection so a changed `smart-archive.useSystem7z`
 * setting takes effect without a window reload. Wired to onDidChangeConfiguration
 * in extension.ts.
 */
export function resetDetectionCache(): void {
  _cachedPath = undefined;
  _cachedVersion = undefined;
  _macPrepared = false;
}

function checkVersion(binaryPath: string, minVersion = MIN_VERSION): boolean {
  if (_cachedVersion !== undefined) return _cachedVersion >= minVersion;

  try {
    const result = spawnSync(binaryPath, [], {
      stdio: "pipe",
      timeout: BINARY_DETECT_TIMEOUT,
      windowsHide: true,
    });
    const output = result.stdout.toString();
    const m = output.match(/7-Zip\s+(?:\(z\)\s+)?(\d+)\.(\d+)/i);
    if (m) {
      const major = parseInt(m[1], 10);
      const minor = parseInt(m[2], 10);
      _cachedVersion = major + minor / 100;
      logger.info({
        event: "system7z.version",
        raw: m[0],
        major,
        minor,
        cached: _cachedVersion,
        minBase: MIN_VERSION,
      });
      return _cachedVersion >= minVersion;
    }
    logger.warn({ event: "system7z.version.unparseable", output: output.slice(0, 100) });
  } catch (err) {
    logger.warn({ event: "system7z.version.checkFailed", err });
  }

  // Do NOT cache the failure: a transient spawn failure (AV lock, momentary
  // load, timeout) must not permanently downgrade the whole session to WASM.
  // Leaving _cachedVersion undefined lets the next call re-probe; detection
  // already validated the binary via versionOk, so this only affects retries.
  return false;
}

const ZSTD_EXTS = new Set([".zst", ".tar.zst", ".tzst"]);
const LZ4_EXTS = new Set([".tar.lz4", ".tlz4"]);
const BROTLI_EXTS = new Set([".tar.br", ".tbr"]);
const SNAPPY_EXTS = new Set([".tar.sz", ".tsz"]);

/**
 * Check whether system 7-Zip is usable for a given archive format.
 * tar.zst / tar.lz4 creation is impossible (7z only unpacks these),
 * tar.br and tar.lz4 are handled entirely by WASM codecs (system 7z bypassed).
 * tar.zst decompression requires v24+.
 * everything else uses system 7z when available (wrapped formats use
 * outer type: gzip/bzip2/xz).
 */
export function hasSystem7zForFormat(extOrLabel: string, isDecompress = false): boolean {
  const config = vscode.workspace.getConfiguration("smart-archive");
  const setting = config.get<string>("useSystem7z", "auto");
  if (setting === "never") {
    logger.debug({ event: "system7z.disabledBySetting" });
    return false;
  }

  // RAR requires a full-format 7-Zip — some distro builds strip RAR support
  // and would fail every RAR operation (list/extract/rebuild). Resolve a
  // RAR-capable binary explicitly instead of using the generic detection.
  const extKey = extOrLabel.startsWith(".") ? extOrLabel : `.${extOrLabel}`;
  if (isRarExt(extKey)) {
    const rarSz = system7zForExt(extKey);
    if (!rarSz) {
      if (setting === "always") {
        vscode.window.showWarningMessage(t("system7z.notInstalled"));
      }
      return false;
    }
    if (!checkVersion(rarSz)) {
      if (setting === "always") {
        vscode.window.showWarningMessage(t("system7z.tooOld"));
      }
      return false;
    }
    return true;
  }

  const sz = detectSystem7z();
  if (!sz) {
    if (setting === "always") {
      vscode.window.showWarningMessage(t("system7z.notInstalled"));
    }
    return false;
  }

  const isZstd =
    ZSTD_EXTS.has(extOrLabel.toLowerCase()) || ZSTD_EXTS.has("." + extOrLabel.toLowerCase());
  const isLz4 =
    LZ4_EXTS.has(extOrLabel.toLowerCase()) || LZ4_EXTS.has("." + extOrLabel.toLowerCase());
  const isBrotli =
    BROTLI_EXTS.has(extOrLabel.toLowerCase()) || BROTLI_EXTS.has("." + extOrLabel.toLowerCase());
  const isSnappy =
    SNAPPY_EXTS.has(extOrLabel.toLowerCase()) || SNAPPY_EXTS.has("." + extOrLabel.toLowerCase());

  // Snappy, Brotli and LZ4 are handled entirely by WASM codecs, bypass system
  // 7z — system 7z cannot decompress these formats at all.
  if (isBrotli || isLz4 || isSnappy) {
    logger.info({
      event: "system7z.skipCodec",
      ext: extOrLabel,
      codec: isBrotli ? "brotli" : isSnappy ? "snappy" : "lz4",
    });
    return false;
  }

  // System 7z cannot create zstd archives at all (only decompress)
  if (isZstd && !isDecompress) {
    logger.info({ event: "system7z.skipCreate", ext: extOrLabel });
    return false;
  }
  // Decompressing zstd → requires v24+
  const minVer = isZstd && isDecompress ? MIN_VERSION_ZSTD : MIN_VERSION;

  if (!checkVersion(sz, minVer)) {
    if (setting === "always") {
      vscode.window.showWarningMessage(t("system7z.tooOld"));
    }
    return false;
  }

  return true;
}

function testBinary(binaryPath: string): boolean {
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
function versionOk(binaryPath: string): boolean {
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

function resolveFromPath(name: string): string | null {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(whichCmd, [name], {
      stdio: "pipe",
      timeout: BINARY_DETECT_TIMEOUT,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout.length > 0) {
      const found = result.stdout.toString().trim().split("\n")[0].trim();
      if (fs.existsSync(found) && testBinary(found)) return found;
    }
  } catch (err) {
    logger.warn(
      {
        event: "system7z.resolveFromPath.failed",
        cmd: whichCmd,
        name,
        platform: process.platform,
        err,
      },
      `${whichCmd} command failed, falling back to manual PATH search`,
    );
    if (process.platform === "win32") {
      const pathExt = (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";");
      const pathDirs = (process.env.PATH || "").split(";");
      for (const dir of pathDirs) {
        for (const ext of pathExt) {
          const full = path.join(dir, name) + (name.includes(".") ? "" : ext.toLowerCase());
          if (fs.existsSync(full) && testBinary(full)) return full;
        }
      }
    }
  }
  return null;
}

// ── Windows code page detection ──────────────────────────────────────

let _codePageCache: string | undefined;

/**
 * Detect the active console code page on Windows.
 * Returns "utf8" if Windows UTF-8 beta is on (chcp 65001), otherwise the
 * ANSI code page identifier (e.g. "cp936" for Chinese). Returns "utf8" for
 * non-Windows platforms.
 */
function detectEncoding(): string {
  if (_codePageCache !== undefined) return _codePageCache;
  if (process.platform !== "win32") {
    _codePageCache = "utf8";
    return "utf8";
  }

  try {
    const r = spawnSync("chcp.com", [], { stdio: "pipe", timeout: 3000, windowsHide: true });
    if (r.status === 0) {
      const m = r.stdout.toString().match(/(\d+)/);
      if (m) {
        const cp = parseInt(m[1], 10);
        if (cp === 65001) {
          _codePageCache = "utf8";
        } else {
          _codePageCache = `cp${cp}`;
        }
        logger.info({ event: "system7z.codepage", cp, encoding: _codePageCache });
        return _codePageCache;
      }
    }
  } catch {
    // chcp.com not available — fall through
  }

  // Fallback: check environment or derive from system locale
  const legacy = process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || "";
  if (legacy.toLowerCase().includes("utf-8") || legacy.toLowerCase().includes("utf8")) {
    _codePageCache = "utf8";
  } else {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (locale.startsWith("ja")) {
      _codePageCache = "cp932";
    } else if (locale.startsWith("ko")) {
      _codePageCache = "cp949";
    } else if (locale.startsWith("zh")) {
      _codePageCache = "cp936";
    } else {
      _codePageCache = "cp1252";
    }
  }
  logger.info({ event: "system7z.codepage", encoding: _codePageCache, method: "fallback" });
  return _codePageCache;
}

/**
 * Decode a Buffer from 7z's stderr/stdout using the detected code page.
 */
function decodeBuffer(buf: Buffer): string {
  if (process.platform !== "win32") return buf.toString("utf8");

  const enc = detectEncoding();
  if (enc === "utf8") return buf.toString("utf8");

  // For legacy code pages, use iconv-lite (already a project dependency)
  return iconv.decode(buf, enc);
}

// ── Compress ─────────────────────────────────────────────────────────

/** Combined check: binary found AND version acceptable */
function getSystem7zOrNull(): string | null {
  const sz = detectSystem7z();
  if (!sz) return null;
  if (!checkVersion(sz)) {
    logger.info({ event: "system7z.fallback.version" });
    return null;
  }
  return sz;
}

const _rarSupportCache = new Map<string, boolean>();

/**
 * Does this 7-Zip binary include RAR (RAR4/RAR5) read support? Some distro
 * builds strip RAR for licensing reasons (e.g. Fedora's 7zip package), in
 * which case they cannot open RAR archives at all.
 */
export function hasRarSupport(binary: string): boolean {
  const cached = _rarSupportCache.get(binary);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const r = spawnSync(binary, ["i"], { stdio: "pipe", timeout: BINARY_DETECT_TIMEOUT });
    if (r.status === 0) {
      const out = `${r.stdout.toString("utf8")}\n${r.stderr.toString("utf8")}`;
      supported = /\bRar5\b/i.test(out) || /\bRar\b/i.test(out);
    }
  } catch {
    supported = false;
  }
  _rarSupportCache.set(binary, supported);
  return supported;
}

/**
 * Resolve the 7-Zip binary for a given archive extension. RAR archives are
 * always handled by a RAR-capable build: the bundled full-format 7zz when
 * available, otherwise a system 7-Zip only if it proves RAR support via
 * `7z i` (some distro builds ship without RAR at all).
 */
export function system7zForExt(extOrLabel: string): string | null {
  const key = extOrLabel.startsWith(".") ? extOrLabel : `.${extOrLabel}`;
  if (isRarExt(key)) {
    const bundled = bundled7zPath();
    if (bundled && hasRarSupport(bundled)) return bundled;
    const sys = detectSystem7z();
    if (sys && hasRarSupport(sys)) return sys;
    return null;
  }
  return getSystem7zOrNull();
}

export async function compressWithSystem7z(
  options: CompressOptions,
  progress?: ProgressLike,
  token?: TokenLike,
  excludePatterns?: string[],
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  const sz = getSystem7zOrNull();
  if (!sz) throw new Error("System 7-Zip not available");

  const outputDir = path.dirname(options.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const typeFlag = formatTo7zType(options.format.label);
  const isWrapped = typeFlag === "gzip" || typeFlag === "bzip2" || typeFlag === "xz";

  // Wrapped formats (tar.gz/bz2/xz): 7z on Windows can't create these in
  // one step. Two-step: create tar first, then compress the tar.
  if (isWrapped) {
    // Derive inner tar name from output: report.tar.gz → report.tar
    let innerName = path.basename(options.outputPath, "." + options.format.label);
    if (!innerName.endsWith(".tar")) innerName += ".tar";
    const tarPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sat_")), innerName);
    try {
      // Step 1: create tar using createTarFile (avoids GNU extensions
      // unsupported by WASM 7z during listing/decompression).
      prog.report({ message: t("compress.creatingTar") });
      await createTarFile(
        tarPath,
        options.targets.map((tg) => tg.fsPath),
        token,
        excludePatterns ?? [],
      );

      // Step 2: compress the tar
      const compressArgs = ["a", `-t${typeFlag}`, options.outputPath, "--", tarPath];
      if (options.password) {
        validatePassword(options.password);
        compressArgs.splice(1, 0, `-p${options.password}`);
      }
      logger.info({
        event: "system7z.compress.wrap",
        output: options.outputPath,
        argsPreview: compressArgs.filter((a) => !a.startsWith("-p")).join(" "),
      });
      prog.report({ message: t("compress.compressingTar", typeFlag) });
      await run7z(sz, compressArgs, progress, token);
    } finally {
      try {
        fs.unlinkSync(tarPath);
      } catch {
        logger.warn({ event: "system7z.compress.unlink.failed" }, "Failed to remove temp tar file");
      }
      try {
        fs.rmSync(path.dirname(tarPath), { recursive: true, force: true });
      } catch {
        logger.warn({ event: "system7z.compress.rmdir.failed" }, "Failed to remove temp directory");
      }
    }
    return;
  }

  // Non-wrapped: one-step with all flags
  const args: string[] = ["a", `-t${typeFlag}`, `-mx${options.level}`, "-mmt=on"];

  if (options.password) {
    validatePassword(options.password);
    args.push(`-p${options.password}`);
    if (options.format.label === "7z") args.push("-mhe=on");
  }
  if (options.volumeSize) args.push(`-v${toBinaryVolumeSize(options.volumeSize)}`);

  if (excludePatterns && excludePatterns.length > 0) {
    const singleTarget = options.targets.length === 1;
    const targetNames = new Set(options.targets.map((tg) => path.basename(tg.fsPath)));
    for (const pat of excludePatterns) {
      if (singleTarget && targetNames.has(pat)) continue;
      args.push(`-xr!${pat}`);
    }
  }

  // Multi-target: pre-filter targets matching exclusion patterns
  let targets = options.targets;
  if (options.targets.length > 1 && excludePatterns?.length) {
    const exclusions = prepareExclusions(excludePatterns);
    targets = options.targets.filter((tg) => !isTargetExcluded(tg.fsPath, exclusions));
  }

  args.push("--", options.outputPath);
  for (const target of targets) args.push(target.fsPath);

  logger.info({
    event: "system7z.compress.start",
    format: options.format.label,
    output: options.outputPath,
    targets: options.targets.length,
    level: options.level,
    encrypted: !!options.password,
    volumes: options.volumeSize ?? "none",
    exclusions: excludePatterns?.length ?? 0,
    argsPreview: args.filter((a) => !a.startsWith("-p")).join(" "),
  });

  prog.report({ message: t("compress.inProgress") });

  try {
    await run7z(sz, args, progress, token);
  } catch (err) {
    logger.error({ event: "system7z.compress.failed", err }, "System 7z compression failed");
    throw err;
  }
}

// ── Decompress ───────────────────────────────────────────────────────

interface WalkedEntry {
  path: string;
  symlink: boolean;
}

/** Recursively walk a directory WITHOUT following symlinks; symlinks are
 *  reported (not traversed) so a caller can reject them. */
function walkDir(root: string): WalkedEntry[] {
  const out: WalkedEntry[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        out.push({ path: full, symlink: true });
      } else if (e.isDirectory()) {
        queue.push(full);
      } else if (e.isFile()) {
        out.push({ path: full, symlink: false });
      }
    }
  }
  return out;
}

/**
 * Defense-in-depth after extraction: reject any symlink left in the staging
 * dir and any real file whose resolved path escapes it. NOTE: this is a
 * secondary net only — the primary defense is preflightSystem7z(), which
 * refuses symlink-bearing archives BEFORE extraction, because a symlink
 * write-through escapes during extraction, before this check can run.
 */
/**
 * Move a single entry, falling back to copy+remove across filesystems.
 * A plain renameSync throws EXDEV when src and dst are on different devices.
 */
function moveEntry(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      fs.cpSync(src, dst, { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * Move everything from srcDir into destDir, merging directories recursively.
 * A naive `renameSync` loop over the top-level entries fails with ENOTEMPTY the
 * moment a top-level directory already exists in destDir (extracting an archive
 * whose top folder collides with an existing one) and — because it is not
 * transactional — leaves the already-moved entries behind as partial output.
 * It also throws EXDEV when destDir is a mount point (parent on another device).
 * This helper merges dir-into-dir, replaces colliding files/type-mismatches, and
 * copies across devices. Call only AFTER verifyStagingDir (no symlinks present).
 */
function moveMerge(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dst = path.join(destDir, name);
    const srcIsDir = fs.lstatSync(src).isDirectory();
    let dstStat: fs.Stats | undefined;
    try {
      dstStat = fs.lstatSync(dst);
    } catch {
      dstStat = undefined;
    }
    if (srcIsDir && dstStat?.isDirectory()) {
      moveMerge(src, dst);
      continue;
    }
    // Collision with a file or a type mismatch (or nothing) — clear dst first so
    // the move is portable (Windows renameSync will not overwrite an existing
    // target), then move.
    if (dstStat) fs.rmSync(dst, { recursive: true, force: true });
    moveEntry(src, dst);
  }
}

function verifyStagingDir(stagingDir: string): void {
  const resolvedStaging = fs.realpathSync(stagingDir);
  const sep = path.sep;
  for (const item of walkDir(stagingDir)) {
    if (item.symlink) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(t("security.symlinkInOutput", item.path));
    }
    let real: string;
    try {
      real = fs.realpathSync(item.path);
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(t("security.pathVerifyFailed", item.path, (err as Error).message), {
        cause: err,
      });
    }
    if (!real.startsWith(resolvedStaging + sep) && real !== resolvedStaging) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(t("security.pathEscape", real, resolvedStaging));
    }
  }
}

/**
 * Pre-extraction guard for the system-7z engine (a single `7z l -slt` pass):
 *   H1 — refuse archives containing symlink entries (path-traversal write-through
 *        happens DURING extraction, so it must be blocked before extracting).
 *   H2 — sum the reported uncompressed sizes and enforce the total-size limit;
 *        checkTotalSize throws → propagates → extraction is aborted.
 * A genuine listing failure (e.g. wrong password) is tolerated: the subsequent
 * extraction will surface that error itself.
 */
async function preflightSystem7z(sz: string, inputPath: string, password: string): Promise<void> {
  const args: string[] = ["l", "-slt"];
  if (password) {
    validatePassword(password);
    args.splice(1, 0, `-p${password}`);
  }
  args.push("--", inputPath);

  let stdout: string;
  try {
    ({ stdout } = await spawnCapture(sz, args));
  } catch {
    logger.warn(
      { event: "system7z.decompress.preflightFailed" },
      "Cannot preflight archive (list failed), proceeding — extraction will surface any error",
    );
    return;
  }

  // H1: 7-Zip -slt marks a symlink with a "Symbolic Link = <target>" property.
  if (/^Symbolic Link = \S/m.test(stdout)) {
    throw new Error(t("security.symlinkEntry"));
  }

  // H2: enforce the uncompressed total-size limit before writing anything.
  // Sum every entry's "Size = <n>" line straight from the raw -slt output so
  // this is NOT bounded by parse7zListing's MAX_ENTRIES cap — otherwise a bomb
  // could hide huge entries after the 100k cap and evade the check. The anchored
  // /^Size = / does not match "Packed Size =", "Physical Size =" or "Headers
  // Size =". checkTotalSize throws — aborting extraction — the moment the
  // running total exceeds the limit, so we stop early on a bomb.
  let total = 0;
  const sizeRe = /^Size = (\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = sizeRe.exec(stdout)) !== null) {
    total = checkTotalSize(total, parseInt(m[1], 10) || 0);
  }
}

export async function decompressWithSystem7z(
  options: DecompressOptions,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  const sz = system7zForExt(getFullExt(options.inputPath));
  if (!sz) throw new Error("System 7-Zip not available");

  checkArchiveInputSize(options.inputPath);
  await preflightSystem7z(sz, options.inputPath, options.password ?? "");

  // Stage on the SAME filesystem as the output dir so the post-extraction move
  // is an atomic same-device rename. Using os.tmpdir() breaks whenever /tmp is a
  // separate mount/tmpfs (common on Linux): renameSync then fails with EXDEV.
  const stagingParent = path.dirname(path.resolve(options.outputDir));
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingParent, ".sa7z_"));

  const args: string[] = ["x", `-o${stagingDir}`, "-mmt=on"];

  if (options.password) {
    validatePassword(options.password);
    args.splice(1, 0, `-p${options.password}`);
  }

  args.push("--", options.inputPath);

  logger.info({
    event: "system7z.decompress.start",
    input: options.inputPath,
    output: options.outputDir,
    staging: stagingDir,
    sizeBytes: calcSplitVolumeTotalSize(options.inputPath) || fs.statSync(options.inputPath).size,
    encrypted: !!options.password,
    argsPreview: args.filter((a) => !a.startsWith("-p")).join(" "),
  });

  prog.report({ message: t("decompress.inProgress") });

  try {
    await run7z(sz, args, progress, token);
    verifyStagingDir(stagingDir);
    moveMerge(stagingDir, options.outputDir);
    logger.info({ event: "system7z.decompress.ok", output: options.outputDir });
  } catch (err) {
    logger.error({ event: "system7z.decompress.failed", err }, "System 7z decompression failed");
    if (fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
    throw err;
  }

  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {}
}

// ── List ─────────────────────────────────────────────────────────────

export async function listWithSystem7z(
  filePath: string,
  password = "",
): Promise<{ path: string; size: number; type: string }[]> {
  const sz = system7zForExt(getFullExt(filePath));
  if (!sz) throw new Error("System 7-Zip not available");

  const archiveName = getBaseName(filePath);
  const args: string[] = ["l", "-slt"];
  if (password) {
    validatePassword(password);
    args.splice(1, 0, `-p${password}`);
  }
  args.push(filePath);

  logger.info({
    event: "system7z.list.start",
    file: filePath,
    encrypted: !!password,
    args: args.filter((a) => !a.startsWith("-p")).join(" "),
  });

  const { stdout } = await spawnCapture(sz, args);
  const results = parse7zListing(stdout, archiveName, filePath);

  logger.debug({ event: "system7z.list.ok", count: results.length });
  return results;
}

// ── Encryption detection ─────────────────────────────────────────────

export async function isEncryptedSystem7z(filePath: string): Promise<boolean> {
  const sz = system7zForExt(getFullExt(filePath));
  if (!sz) throw new Error("System 7-Zip not available");

  checkFileSize(fs.statSync(filePath).size);

  // Strategy: `7z l -slt -p` with empty password piped via stdin.
  // Non-header-encrypted archives list normally and show "Encrypted = +".
  // Header-encrypted archives (7z -mhe=on) fail to list and emit
  // "Wrong password" / "Cannot open encrypted archive" to stderr.
  try {
    const { stdout, stderr } = await spawnCapture(sz, ["l", "-slt", "-p", filePath]);
    if (stdout.includes("Encrypted = +")) {
      logger.debug({ event: "system7z.isEncrypted", encrypted: true, file: filePath });
      return true;
    }
    // Listing succeeded but no encrypted entries — not encrypted
    if (stdout.includes("Path = ")) {
      logger.debug({ event: "system7z.isEncrypted", encrypted: false, file: filePath });
      return false;
    }
    // Listing produced no entries — likely header-encrypted
    const msg = (stdout + stderr).toLowerCase();
    if (isPasswordOrEncryptError(msg)) {
      logger.debug({
        event: "system7z.isEncrypted",
        encrypted: true,
        via: "stderr",
        file: filePath,
      });
      return true;
    }
    logger.debug({
      event: "system7z.isEncrypted",
      encrypted: false,
      via: "noEntries",
      file: filePath,
    });
    return false;
  } catch (err) {
    // spawnCapture only rejects on timeout or spawn error
    logger.warn(
      { event: "system7z.isEncrypted.detectFailed", err },
      "Encryption detection via listing failed, falling back to test",
    );
    try {
      const { stderr } = await spawnCapture(sz, ["t", "-p", filePath]);
      return isPasswordOrEncryptError(stderr);
    } catch {
      return false;
    }
  }
}

// ── Shared spawn utilities ───────────────────────────────────────────

interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Mask -p<password> tokens for safe logging */
function maskArgs(args: string[]): string {
  return args.map((a) => (a.startsWith("-p") ? "-p***" : a)).join(" ");
}

interface SpawnCaptureOpts {
  cwd?: string;
  timeoutMs?: number;
}

export function spawnCapture(
  binary: string,
  args: string[],
  opts?: number | SpawnCaptureOpts,
): Promise<CaptureResult> {
  const { cwd, timeoutMs } =
    typeof opts === "number"
      ? { timeoutMs: opts, cwd: undefined }
      : { timeoutMs: SPAWN_CAPTURE_TIMEOUT, ...opts };

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    logger.debug({ event: "system7z.spawn", binary, args: maskArgs(args) });

    const proc = spawn(binary, args, {
      stdio: "pipe",
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
    });

    // Close stdin immediately — prevents 7z from hanging when -p (prompt)
    // is used without a value, e.g. in encryption detection.
    // All actual passwords are passed via -p<value> on the command line.
    proc.stdin?.end();

    const MAX_CAPTURE_BYTES = 500 * 1024 * 1024; // 500 MB
    let totalCaptured = 0;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`7z timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => {
      stdoutChunks.push(d);
      totalCaptured += d.length;
      if (totalCaptured > MAX_CAPTURE_BYTES) {
        proc.kill();
        settled = true;
        clearTimeout(timer);
        reject(new Error("7z output exceeded 500 MB limit"));
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderrChunks.push(d);
      totalCaptured += d.length;
      if (totalCaptured > MAX_CAPTURE_BYTES) {
        proc.kill();
        settled = true;
        clearTimeout(timer);
        reject(new Error("7z output exceeded 500 MB limit"));
      }
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.error({ event: "system7z.spawn.error", binary, err }, "Failed to spawn 7z");
      reject(new Error(`7z spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Decode accumulated buffers at close to avoid splitting multi-byte
      // UTF-8 characters across chunk boundaries in large listings.
      const stdout = decodeBuffer(Buffer.concat(stdoutChunks));
      const stderr = decodeBuffer(Buffer.concat(stderrChunks));
      logger.debug({ event: "system7z.spawn.close", binary, code, stderrLen: stderr.length });
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Run system 7z with progress parsing and exit-code handling.
 *
 * 7-Zip exit codes:
 *   0   - success
 *   1   - warning (non-fatal, e.g. some files could not be opened but
 *          archive was created/extracted successfully)
 *   2   - fatal error
 *   7   - command line error
 *   8   - not enough memory
 *   255 - user stopped the process
 */
function run7z(
  binary: string,
  args: string[],
  progress?: ProgressLike,
  token?: TokenLike,
  cwd?: string,
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  return new Promise<void>((resolve, reject) => {
    const combinedChunks: Buffer[] = [];
    let lastPct = -1;
    const startTime = Date.now();
    let settled = false;

    logger.debug({ event: "system7z.run.start", binary, argsPreview: maskArgs(args) });

    const proc = spawn(binary, args, {
      stdio: "pipe",
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });

    // Close stdin immediately — no password via stdin, all passwords
    // are passed on the command line via -p<password> flag.
    proc.stdin?.end();

    const MAX_RUN_BYTES = 500 * 1024 * 1024;
    let runBytes = 0;

    const timeoutTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        if (process.platform === "win32" && proc.pid) {
          try {
            spawn("taskkill", ["/PID", String(proc.pid), "/F"], { windowsHide: true });
          } catch {
            // best effort
          }
        }
        reject(new Error(`7z timed out after ${RUN7Z_TIMEOUT}ms`));
      }
    }, RUN7Z_TIMEOUT);

    const cancelSub = token?.onCancellationRequested?.(() => {
      logger.info({ event: "system7z.run.cancelled", elapsedMs: Date.now() - startTime });
      proc.kill("SIGTERM");
      // On Windows SIGTERM may not work, try taskkill
      if (process.platform === "win32" && proc.pid) {
        try {
          spawn("taskkill", ["/PID", String(proc.pid), "/F"], { windowsHide: true });
        } catch {
          // best effort
        }
      }
    });

    proc.stdout?.on("data", (d: Buffer) => {
      combinedChunks.push(d);
      runBytes += d.length;
      if (runBytes > MAX_RUN_BYTES) {
        proc.kill();
        settled = true;
        clearTimeout(timeoutTimer);
        cancelSub?.dispose();
        reject(new Error("7z output exceeded 500 MB limit"));
        return;
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const text = decodeBuffer(d);
      combinedChunks.push(d);
      runBytes += d.length;
      if (runBytes > MAX_RUN_BYTES) {
        proc.kill();
        settled = true;
        clearTimeout(timeoutTimer);
        cancelSub?.dispose();
        reject(new Error("7z output exceeded 500 MB limit"));
        return;
      }

      // Parse progress: 7z outputs lines like " 45% 12 - file.txt" to stderr
      const m = text.match(/(\d{1,3})%/);
      if (m) {
        const pct = parseInt(m[1], 10);
        if (pct !== lastPct) {
          lastPct = pct;
          prog.report({ message: `${pct}%` });
        }
      }
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      cancelSub?.dispose();
      const elapsed = Date.now() - startTime;
      logger.error(
        {
          event: "system7z.run.error",
          binary,
          elapsedMs: elapsed,
          err,
        },
        "Failed to spawn 7z process",
      );
      reject(
        new Error(`System 7-Zip failed to start (${err.message}). Ensure 7-Zip is installed.`),
      );
    });

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      cancelSub?.dispose();
      const elapsed = Date.now() - startTime;
      const combinedOutput = decodeBuffer(Buffer.concat(combinedChunks));
      const logMeta = {
        event: "system7z.run.close",
        code,
        signal,
        elapsedMs: elapsed,
        stderrTail: combinedOutput.slice(-120),
      };

      if (token?.isCancellationRequested) {
        logger.info({ ...logMeta, cancelled: true });
        reject(new vscode.CancellationError());
        return;
      }

      if (code === 0) {
        logger.info(logMeta);
        resolve();
        return;
      }

      // 7-Zip exit code 1 means "Warning (Non fatal error(s))" per official docs.
      // Some files may have failed but the archive was processed successfully.
      // This is not a fatal error, so resolve rather than reject.
      if (code === 1) {
        logger.warn(
          { ...logMeta, event: "system7z.run.warning", stderrTail: combinedOutput.slice(-200) },
          "7z exited with warning (code 1)",
        );
        resolve();
        return;
      }

      // code 2+ or null (killed by signal)
      const reason =
        code === null
          ? `killed by signal ${signal}`
          : code === 2
            ? "fatal error"
            : code === 7
              ? "command line error"
              : code === 8
                ? "out of memory"
                : `exit code ${code}`;

      logger.error({ ...logMeta, event: "system7z.run.failed", reason });
      reject(new Error(`7z ${reason}${combinedOutput ? `\n${combinedOutput.slice(-300)}` : ""}`));
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Maps Smart Archive format labels to 7-Zip `-t` type flags.
 *
 * This map is intentionally limited — it only lists formats that system
 * 7-Zip handles directly. Codec-based wrapped formats (tar.zst, tar.lz4,
 * tar.br) are routed through WASM before this function is ever reached
 * (see hasSystem7zForFormat). Adding a new format to FORMAT_TABLE does
 * NOT automatically require an entry here; only add it if system 7-Zip
 * can natively create/extract that format.
 */
const FORMAT_7Z_MAP: Record<string, string> = {
  "7z": "7z",
  zip: "zip",
  tar: "tar",
  "tar.gz": "gzip",
  "tar.bz2": "bzip2",
  "tar.xz": "xz",
  wim: "wim",
};

function formatTo7zType(label: string): string {
  return FORMAT_7Z_MAP[label] || label;
}

// ── Archive modification (direct on disk, no VFS) ───────────────────

function copyDirRecursive(srcDir: string, destDir: string, exclusions?: ExclusionSet): void {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (exclusions && isPathExcluded(name, exclusions)) {
      logger.info({
        event: "system7z.add.skipExcludedRecursive",
        name,
        dir: srcDir,
      });
      continue;
    }
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath, exclusions);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function addToArchiveSystem7z(
  archivePath: string,
  localPaths: string[],
  targetDir: string,
  exclusions?: ExclusionSet,
  password?: string,
): Promise<void> {
  const sz = system7zForExt(getFullExt(archivePath));
  if (!sz) throw new Error("System 7-Zip not available");

  const normDir = targetDir.replace(/\\/g, "/").replace(/^\/+/, "");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saa_"));
  let addedCount = 0;

  try {
    for (const localPath of localPaths) {
      const name = getBaseName(localPath);
      if (exclusions && isPathExcluded(name, exclusions)) {
        logger.info({ event: "system7z.add.skipExcluded", path: localPath, name });
        continue;
      }

      const stat = fs.statSync(localPath);
      const destRel = normDir ? path.join(normDir, name) : name;
      const destAbs = path.join(tmpRoot, destRel);

      if (stat.isDirectory()) {
        fs.mkdirSync(destAbs, { recursive: true });
        copyDirRecursive(localPath, destAbs, exclusions);
      } else {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.copyFileSync(localPath, destAbs);
      }
      addedCount++;
    }

    if (addedCount === 0) {
      logger.info({ event: "system7z.add.nothingToAdd", archivePath });
      return;
    }

    const args: string[] = ["a", archivePath, "-aot", "-r"];
    if (password) {
      validatePassword(password);
      args.splice(1, 0, `-p${password}`);
    }
    args.push("*");

    logger.info({
      event: "system7z.add.start",
      archivePath,
      files: addedCount,
      targetDir: normDir || "(root)",
      encrypted: !!password,
    });

    await spawnCaptureInCwd(sz, args, tmpRoot);

    logger.info({ event: "system7z.add.ok", archivePath, files: addedCount });
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      logger.warn({ event: "system7z.add.cleanup.failed" }, "Failed to clean up temp dir");
    }
  }
}

function spawnCaptureInCwd(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs = SPAWN_CAPTURE_TIMEOUT,
): Promise<CaptureResult> {
  return spawnCapture(binary, args, { cwd, timeoutMs });
}

export async function deleteFromArchiveSystem7z(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<void> {
  const sz = system7zForExt(getFullExt(archivePath));
  if (!sz) throw new Error("System 7-Zip not available");

  const dArgs = ["d", archivePath, "-y"];
  if (password) {
    validatePassword(password);
    dArgs.splice(1, 0, `-p${password}`);
  }
  dArgs.push(...selectedPaths.map((p) => sanitizeCliPath(p.replace(/\\/g, "/"))));

  logger.info({
    event: "system7z.delete.start",
    archivePath,
    entries: selectedPaths.length,
    encrypted: !!password,
  });

  // run7z (not spawnCapture) so the caller sees real progress: deleting
  // rebuilds the whole archive (7-Zip has no in-place delete) and
  // recompresses the remaining data — with -mx9 archives that takes a
  // while, and without progress it looks frozen. cwd = archive dir so
  // 7-Zip's atomic <archive>.tmp replacement lands next to the archive.
  await run7z(sz, dArgs, progress, token, path.dirname(archivePath));

  logger.info({ event: "system7z.delete.ok", archivePath, entries: selectedPaths.length });
}

export async function renameInArchiveSystem7z(
  archivePath: string,
  oldPath: string,
  newPath: string,
  password?: string,
): Promise<void> {
  const sz = system7zForExt(getFullExt(archivePath));
  if (!sz) throw new Error("System 7-Zip not available");

  const rnArgs = ["rn", archivePath, sanitizeCliPath(oldPath), sanitizeCliPath(newPath)];
  if (password) {
    validatePassword(password);
    rnArgs.splice(1, 0, `-p${password}`);
  }

  logger.info({
    event: "system7z.rename.start",
    archivePath,
    oldPath,
    newPath,
    encrypted: !!password,
  });

  await spawnCaptureInCwd(sz, rnArgs, path.dirname(archivePath));

  logger.info({ event: "system7z.rename.ok", archivePath, oldPath, newPath });
}
