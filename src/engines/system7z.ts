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
 *     accordingly; `-sccUTF-8` only affects `l` command
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
import * as iconv from "iconv-lite";
import type { CompressOptions, DecompressOptions } from "../types";
import { t } from "../i18n";
import { logger } from "../utils/logger";
import { validatePassword, checkFileSize } from "../utils/security";
import { parse7zListing } from "../utils/parse7z";
import { getBaseName } from "../utils/path";
import { toBinaryVolumeSize } from "../utils/volume-sizes";
import { prepareExclusions, isTargetExcluded } from "../utils/exclude";
import { checkArchiveInputSize, calcSplitVolumeTotalSize } from "./vfs-io";

// ── Detection (cached) ───────────────────────────────────────────────

let _cachedPath: string | null | undefined;

/**
 * Detect a system-installed 7-Zip binary.
 * Searches known paths first, then PATH. Result is cached.
 */
export function detectSystem7z(): string | null {
  if (_cachedPath !== undefined) return _cachedPath;

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

  _cachedPath = null;
  logger.info({ event: "system7z.notFound", platform: process.platform });
  return null;
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

function checkVersion(binaryPath: string, minVersion = MIN_VERSION): boolean {
  if (_cachedVersion !== undefined) return _cachedVersion >= minVersion;

  try {
    const result = spawnSync(binaryPath, [], { stdio: "pipe", timeout: 5000, windowsHide: true });
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

  _cachedVersion = 0;
  return false;
}

const ZSTD_EXTS = new Set([".zst", ".tar.zst", ".tzst"]);
const LZ4_EXTS = new Set([".tar.lz4", ".tlz4"]);
const BROTLI_EXTS = new Set([".tar.br", ".tbr"]);

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

  // Brotli and LZ4 are handled entirely by WASM codecs, bypass system 7z —
  // system 7z cannot decompress these formats at all.
  if (isBrotli || isLz4) {
    logger.info({ event: "system7z.skipCodec", ext: extOrLabel, codec: isBrotli ? "brotli" : "lz4" });
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
    const result = spawnSync(binaryPath, [], { stdio: "pipe", timeout: 5000, windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Quick version check during detection — no shared cache pollution */
function versionOk(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, [], { stdio: "pipe", timeout: 5000, windowsHide: true });
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
    const result = spawnSync(whichCmd, [name], { stdio: "pipe", timeout: 5000, windowsHide: true });
    if (result.status === 0 && result.stdout.length > 0) {
      const found = result.stdout.toString().trim().split("\n")[0].trim();
      if (fs.existsSync(found) && testBinary(found)) return found;
    }
  } catch {
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

export async function compressWithSystem7z(
  options: CompressOptions,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
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
      // Step 1: create tar with exclusions
      const tarArgs = ["a", "-ttar", "-mx0", tarPath];
      if (excludePatterns && excludePatterns.length > 0) {
        const singleTarget = options.targets.length === 1;
        const targetNames = new Set(options.targets.map((tg) => path.basename(tg.fsPath)));
        for (const pat of excludePatterns) {
          if (singleTarget && targetNames.has(pat)) continue;
          tarArgs.push(`-xr!${pat}`);
        }
      }
      // Multi-target: pre-filter targets matching exclusion patterns
      let wrappedTargets = options.targets;
      if (options.targets.length > 1 && excludePatterns?.length) {
        const exclusions = prepareExclusions(excludePatterns);
        wrappedTargets = options.targets.filter((tg) => !isTargetExcluded(tg.fsPath, exclusions));
      }
      tarArgs.push("--", ...wrappedTargets.map((tg) => tg.fsPath));
      logger.info({ event: "system7z.compress.tar", argsPreview: tarArgs.join(" ") });
      prog.report({ message: t("compress.creatingTar") });
      await run7z(sz, tarArgs, progress, token);

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
      } catch { logger.warn({ event: "system7z.compress.unlink.failed" }, "Failed to remove temp tar file") }
      try {
        fs.rmSync(path.dirname(tarPath), { recursive: true, force: true });
      } catch { logger.warn({ event: "system7z.compress.rmdir.failed" }, "Failed to remove temp directory") }
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

export async function decompressWithSystem7z(
  options: DecompressOptions,
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  const sz = getSystem7zOrNull();
  if (!sz) throw new Error("System 7-Zip not available");

  checkArchiveInputSize(options.inputPath);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const args: string[] = ["x", `-o${options.outputDir}`, "-mmt=on"];

  if (options.password) {
    validatePassword(options.password);
    args.splice(1, 0, `-p${options.password}`);
  }

  args.push("--", options.inputPath);

  logger.info({
    event: "system7z.decompress.start",
    input: options.inputPath,
    output: options.outputDir,
    sizeBytes: calcSplitVolumeTotalSize(options.inputPath) || fs.statSync(options.inputPath).size,
    encrypted: !!options.password,
    argsPreview: args.filter((a) => !a.startsWith("-p")).join(" "),
  });

  prog.report({ message: t("decompress.inProgress") });

  try {
    await run7z(sz, args, progress, token);
  } catch (err) {
    logger.error({ event: "system7z.decompress.failed", err }, "System 7z decompression failed");
    throw err;
  }
}

// ── List ─────────────────────────────────────────────────────────────

export async function listWithSystem7z(
  filePath: string,
  password = "",
): Promise<{ path: string; size: number; type: string }[]> {
  const sz = getSystem7zOrNull();
  if (!sz) throw new Error("System 7-Zip not available");

  const archiveName = getBaseName(filePath);
  const args: string[] = ["l", "-slt", "-sccUTF-8"];
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
  const sz = getSystem7zOrNull();
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
    if (msg.includes("encrypt") || msg.includes("wrong password") || msg.includes("cannot open")) {
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
      const msg = stderr.toLowerCase();
      return (
        msg.includes("encrypt") || msg.includes("wrong password") || msg.includes("cannot open")
      );
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

export function spawnCapture(binary: string, args: string[], timeoutMs = 30_000): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    logger.debug({ event: "system7z.spawn", binary, args: args.join(" ") });

    const proc = spawn(binary, args, { stdio: "pipe", windowsHide: true, timeout: timeoutMs });

    // Close stdin immediately — prevents 7z from hanging when -p (prompt)
    // is used without a value, e.g. in encryption detection.
    // All actual passwords are passed via -p<value> on the command line.
    proc.stdin?.end();

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`7z timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += decodeBuffer(d);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += decodeBuffer(d);
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
  progress?: vscode.Progress<{ message?: string }>,
  token?: vscode.CancellationToken,
): Promise<void> {
  const prog = progress ?? { report: () => {} };
  return new Promise<void>((resolve, reject) => {
    let combinedOutput = "";
    let lastPct = -1;
    const startTime = Date.now();

    logger.debug({ event: "system7z.run.start", binary, argsPreview: args.join(" ") });

    const proc = spawn(binary, args, { stdio: "pipe", windowsHide: true });

    // Close stdin immediately — no password via stdin, all passwords
    // are passed on the command line via -p<password> flag.
    proc.stdin?.end();

    token?.onCancellationRequested(() => {
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
      combinedOutput += decodeBuffer(d);
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const text = decodeBuffer(d);
      combinedOutput += text;

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
      const elapsed = Date.now() - startTime;
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
