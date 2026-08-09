/**
 * System 7-Zip engine — Smart Archive VSCode Extension
 *
 * Detects a local 7-Zip installation and uses it for
 * compress/decompress/list operations with better performance
 * than the bundled 7zz WASM engine.
 *
 * Falls back to the bundled 7zz WASM engine when no system 7-Zip is found.
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
import { CancelledError, type TokenLike, type ProgressLike } from "../utils/cancellation";
import * as iconv from "iconv-lite";
import type { CompressOptions, DecompressOptions, SevenZipMethod } from "../types";
import {
  mapLizardLevel,
  normalizeSevenZipMethod,
  SEVEN_ZIP_METHOD_CODECS,
} from "../utils/sevenZipMethod";
import { t } from "../i18n";
import { logger } from "../utils/logger";
import { isPasswordOrEncryptError } from "../utils/errorClassifier";
import { validatePassword, sanitizeCliPath } from "../utils/security";
import { parse7zListing } from "../utils/parse7z";
import { withStage } from "../utils/progress-scale";
import { getBaseName } from "../utils/path";
import {
  BINARY_DETECT_TIMEOUT,
  RUN7Z_TIMEOUT,
  CHILD_CAPTURE_MAX_BYTES,
  SPAWN_CAPTURE_TIMEOUT,
  getFullExt,
  TAR_INNER_PATTERNS,
  UNWRAP_MAX_DEPTH,
  UNWRAP_MAX_TAR_FILES,
} from "../constants";
import { toBinaryVolumeSize } from "../utils/volume-sizes";
import { prepareExclusions, isTargetExcluded, isPathExcluded } from "../utils/exclude";
import type { ExclusionSet } from "../utils/exclude";
import { calcSplitVolumeTotalSize } from "./vfs-io";
import { checkTotalSize } from "../utils/security";
import { createTarFile } from "./tar-writer";
import { isRarExt } from "../utils/rar";
import {
  bundled7zPath,
  testBinary,
  versionOk,
  MIN_VERSION,
  MIN_VERSION_ZSTD,
  resetBundledMacPrep,
} from "./bundled7z";

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

  // "never": disable the native engine entirely (→ WASM).
  if (setting === "never") {
    logger.debug({ event: "system7z.disabledBySetting" });
    _cachedPath = null;
    return null;
  }

  const bundled = bundled7zPath();

  // "bundled": skip system detection and force the VSIX-bundled 7zz
  // (→ null / WASM when it is missing or cannot run on this platform).
  if (setting === "bundled") {
    _cachedPath = bundled;
    logger.info({
      event: _cachedPath ? "system7z.detected" : "system7z.notFound",
      path: _cachedPath ?? undefined,
      method: "bundled-forced",
      platform: process.platform,
    });
    return _cachedPath;
  }

  const system = findSystem7z();

  // "always": force the system install (warn when it is missing).
  if (setting === "always") {
    if (!system) {
      vscode.window.showWarningMessage(t("system7z.notInstalled"));
    }
    _cachedPath = system;
    return system;
  }

  // "auto": bundled 7-Zip ZS is the reference. Platforms without a bundled
  // binary (macOS x64, linux arm, Windows ia32) go straight to the WASM
  // engine. A system install is used only when it is at least as capable as
  // the bundled fork (stock 7-Zip lacks FLZMA2/ZSTD/BROTLI → bundled wins).
  if (!bundled) {
    _cachedPath = null;
    logger.info({
      event: "system7z.notFound",
      reason: "no-bundled",
      platform: process.platform,
    });
    return null;
  }
  if (!system || !isAtLeastAsCapable(system, bundled)) {
    _cachedPath = bundled;
    logger.info({
      event: "system7z.detected",
      path: bundled,
      method: "bundled",
      reason: system ? "system-inferior" : "no-system",
      platform: process.platform,
    });
    return bundled;
  }

  _cachedPath = system;
  logger.info({
    event: "system7z.detected",
    path: system,
    method: "system",
    platform: process.platform,
  });
  return system;
}

/** Find a system-installed 7-Zip binary: known paths first, then PATH. */
function findSystem7z(): string | null {
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
    // Check version before accepting — skip old p7zip if newer 7z/7zz is also present.
    if (fs.existsSync(c) && testBinary(c) && versionOk(c)) return c;
  }

  const names =
    process.platform === "win32" ? ["7z.exe", "7za.exe", "7zz.exe"] : ["7z", "7za", "7zz"];
  for (const name of names) {
    const found = resolveFromPath(name);
    if (found && testBinary(found) && versionOk(found)) return found;
  }
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

let _cachedVersion: number | undefined;

interface SevenZipCapabilities {
  version: number;
  /** Raw `7zz i` output; codec support is matched by name. */
  codecsText: string;
}

const METHOD_FALLBACK: Record<SevenZipMethod, SevenZipMethod> = {
  zstd: "flzma2",
  brotli: "flzma2",
  lz4: "lzma2",
  deflate: "lzma2",
  bzip2: "lzma2",
  lizard: "lzma2",
  flzma2: "lzma2",
  lzma2: "lzma2",
};

const _probeCache = new Map<string, SevenZipCapabilities | null>();

/**
 * Reset the cached engine detection so a changed `smart-archive.useSystem7z`
 * setting takes effect without a window reload. Wired to onDidChangeConfiguration
 * in extension.ts.
 */
export function resetDetectionCache(): void {
  _cachedPath = undefined;
  _cachedVersion = undefined;
  _probeCache.clear();
  resetBundledMacPrep();
}

/** Probe one 7z binary's capabilities (`7zz i`), cached per path. */
function probe7z(binaryPath: string): SevenZipCapabilities | null {
  const cached = _probeCache.get(binaryPath);
  if (cached !== undefined) return cached;
  let caps: SevenZipCapabilities | null = null;
  try {
    const r = spawnSync(binaryPath, ["i"], {
      stdio: "pipe",
      timeout: BINARY_DETECT_TIMEOUT,
      windowsHide: true,
    });
    const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    const m = out.match(/7-Zip\s+(?:\(z\)\s+)?(\d+)\.(\d+)/i);
    if (m) {
      caps = {
        version: parseInt(m[1], 10) + parseInt(m[2], 10) / 100,
        codecsText: out,
      };
    }
  } catch {
    caps = null;
  }
  _probeCache.set(binaryPath, caps);
  return caps;
}

function hasCodec(caps: SevenZipCapabilities | null, name: string): boolean {
  return !!caps && new RegExp(`\\b${name}\\b`).test(caps.codecsText);
}

/** Extract codec names / hex IDs from `7z l -slt` Method lines. */
function parseMethodTokens(listOutput: string): string[] {
  const tokens = new Set<string>();
  const tokenRe = /[A-Za-z][A-Za-z0-9]*|[0-9A-Fa-f]{6,8}/g;
  for (const line of listOutput.split("\n")) {
    const m = line.match(/^\s*Method\s*=\s*(.+)$/i);
    if (!m) continue;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(m[1]))) tokens.add(token[0]);
  }
  return [...tokens];
}

/** Known codec names + hex IDs from a `7z i` probe, normalized for lookup. */
function codecTable(caps: SevenZipCapabilities | null): { names: Set<string>; ids: Set<string> } {
  const names = new Set<string>();
  const ids = new Set<string>();
  if (!caps) return { names, ids };
  const start = caps.codecsText.indexOf("Codecs:");
  const end = caps.codecsText.indexOf("Hashers:", start);
  const section = caps.codecsText.slice(start >= 0 ? start : 0, end >= 0 ? end : undefined);
  const lineRe = /^\s*(?:\d+\s+)?[A-Za-z0-9]*\s+([0-9A-Fa-f]+)\s+([A-Za-z0-9]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(section))) {
    ids.add(m[1].replace(/^0+/, "").toLowerCase());
    names.add(m[2]);
  }
  return { names, ids };
}

/**
 * Whether the currently selected system 7-Zip can decode every method used in
 * an archive. `7z l -slt` can list archives whose codecs the binary does not
 * know — unknown methods appear as hex IDs (e.g. `04F71101` for ZSTD) — so we
 * parse the Method lines and check each token against the binary's codec
 * table. FLZMA2 shows up as `LZMA2` (same method ID) and extracts fine.
 * Returns true when listing fails for unrelated reasons (e.g. encrypted), so
 * genuine errors still surface from the extraction attempt itself.
 */
export function system7zCanDecompress(inputPath: string): boolean {
  const sz = detectSystem7z();
  if (!sz) return false;
  let r;
  try {
    r = spawnSync(sz, ["l", "-slt", inputPath], {
      stdio: "pipe",
      input: "",
      timeout: BINARY_DETECT_TIMEOUT * 2,
      windowsHide: true,
    });
  } catch {
    return true;
  }
  const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
  if (r.status !== 0) {
    return !/unsupported method|cannot open the file as archive|can not open the file as archive/i.test(
      out,
    );
  }
  const { names, ids } = codecTable(probe7z(sz));
  for (const token of parseMethodTokens(out)) {
    if (/^[0-9A-Fa-f]+$/.test(token)) {
      if (!ids.has(token.replace(/^0+/, "").toLowerCase())) return false;
    } else if (!names.has(token)) {
      // Method lines also carry free-text parameters (e.g. "ZSTD v1 l3",
      // "Lizard v2 l10", "LZMA2:12k"). The listing binary prints a name only
      // for codecs it knows, so unknown words are parameters — ignore them.
      continue;
    }
  }
  return true;
}

/** True when `candidate` exposes at least the codecs and version of `reference`. */
function isAtLeastAsCapable(candidate: string, reference: string): boolean {
  const a = probe7z(candidate);
  const b = probe7z(reference);
  if (!a || !b) return false;
  if (a.version < b.version) return false;
  // The bundled fork's extra codecs are the ones stock 7-Zip lacks.
  for (const codec of ["FLZMA2", "ZSTD", "BROTLI", "LZ4", "LIZARD"]) {
    if (hasCodec(b, codec) && !hasCodec(a, codec)) return false;
  }
  return true;
}

/** Pick the best supported method for a binary via the fallback chain. */
function resolveMethodForBinary(binaryPath: string, wanted: SevenZipMethod): SevenZipMethod {
  const caps = probe7z(binaryPath);
  let method = wanted;
  while (method !== "lzma2" && !hasCodec(caps, SEVEN_ZIP_METHOD_CODECS[method])) {
    method = METHOD_FALLBACK[method];
  }
  return method;
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
 * tar.br / tar.lz4 / tar.sz are handled by the codec engine
 * (native first, WASM fallback), so system 7z is bypassed for them.
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

  // Snappy, Brotli and LZ4 are handled by the codec engine (native first,
  // WASM fallback), bypassing system 7z — system 7z cannot decompress
  // these formats at all.
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
  const sz = getSystem7zOrNull();
  if (!sz) throw new Error("System 7-Zip not available");

  const outputDir = path.dirname(options.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // `7z a` UPDATES an existing archive (keeps old entries and adds the new
  // ones) instead of replacing it — the WASM path and the rar5 engine both
  // create fresh. This function is only ever used for creation (add-to-
  // archive goes through addToArchiveSystem7z), so a pre-existing output is
  // a replace intent (e.g. a save-dialog overwrite) — drop it first to make
  // the engines behave identically instead of silently merging archives.
  if (fs.existsSync(options.outputPath)) {
    logger.info(
      { event: "system7z.compress.replaceExisting", output: options.outputPath },
      "Replacing existing output archive",
    );
    fs.unlinkSync(options.outputPath);
  }

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
      const packProgress = progress ? withStage(progress, "pack") : undefined;
      packProgress?.report({ message: t("compress.creatingTar") });
      await createTarFile(
        tarPath,
        options.targets.map((tg) => tg.fsPath),
        token,
        excludePatterns ?? [],
        packProgress,
      );

      // Step 2: compress the tar. Honor the UI level (xz: -mx0…-mx9 maps to
      // the LZMA2 dictionary preset); without -mx the handler always uses
      // the default level, which makes "fast" tar.xz requests pointless.
      const compressArgs = [
        "a",
        `-t${typeFlag}`,
        `-mx${options.level}`,
        options.outputPath,
        "--",
        tarPath,
      ];
      if (options.password) {
        validatePassword(options.password);
        // Empty -p switch makes 7-Zip prompt for the password; the value is
        // fed via stdin by run7z (never on the command line).
        compressArgs.splice(1, 0, "-p");
      }
      // 7-Zip only prints live percentages when stderr is a console; when
      // piped it silently buffers the archive and writes it at the end.
      // -bsp1 forces the progress stream onto stdout so it stays parseable.
      if (progress) compressArgs.splice(1, 0, "-bsp1");
      logger.info({
        event: "system7z.compress.wrap",
        output: options.outputPath,
        argsPreview: compressArgs.filter((a) => !a.startsWith("-p")).join(" "),
      });
      const compressProgress = progress ? withStage(progress, "compress") : undefined;
      compressProgress?.report({ message: t("compress.compressingTar", typeFlag) });
      await run7z(
        sz,
        compressArgs,
        compressProgress,
        token,
        undefined,
        options.password,
        progress
          ? {
              outputPath: options.outputPath,
              totalInputBytes: fs.statSync(tarPath).size,
            }
          : undefined,
      );
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

  // Non-wrapped: one-step with all flags. .7z uses the configured method
  // (default Fast LZMA2). Level 0 means store (Copy) — stock 7-Zip only
  // stores at -mx0 when no method is named, and the fork maps -mx0 of its
  // new codecs to "fastest" (still compressing), so force -m0=Copy.
  const args: string[] = ["a", `-t${typeFlag}`, "-mmt=on"];
  let method: SevenZipMethod | undefined;
  if (options.format.label === "7z") {
    if (options.level === 0) {
      args.push("-m0=Copy");
    } else {
      const wanted = normalizeSevenZipMethod(options.sevenZipMethod);
      method = resolveMethodForBinary(sz, wanted);
      if (method !== wanted) {
        logger.warn(
          { event: "system7z.methodFallback", wanted, method, binary: sz },
          `7z method ${wanted} unsupported by ${sz}; using ${method}`,
        );
      }
      args.push(`-m0=${SEVEN_ZIP_METHOD_CODECS[method]}`);
    }
  }
  // LizardMT speaks levels 10–49; map the UI's 0–9 scale onto it.
  const mxLevel =
    method === "lizard" && options.level > 0 ? mapLizardLevel(options.level) : options.level;
  args.push(`-mx${mxLevel}`);
  // Force progress to stdout (see wrapped path above) so the percentage
  // parser works even when the archive is buffered until the end.
  if (progress) args.push("-bsp1");

  if (options.password) {
    validatePassword(options.password);
    // Empty -p switch triggers the stdin password prompt (see run7z).
    args.push("-p");
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

  const compressProgress = progress ? withStage(progress, "compress") : undefined;
  compressProgress?.report({ message: t("compress.inProgress") });

  try {
    const monitorOutput = progress
      ? {
          outputPath: options.outputPath,
          totalInputBytes: sumTargetBytes(targets),
        }
      : undefined;
    logger.info({
      event: "system7z.compress.monitor",
      progress: !!progress,
      outputPath: options.outputPath,
      totalInputBytes: monitorOutput?.totalInputBytes,
    });
    await run7z(sz, args, compressProgress, token, undefined, options.password, monitorOutput);
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
async function preflightSystem7z(
  sz: string,
  inputPath: string,
  password: string,
  enforceTotalSize = true,
): Promise<void> {
  const args: string[] = ["l", "-slt"];
  args.push("--", inputPath);

  let stdout: string;
  try {
    // No -p switch: for an encrypted archive 7z prompts and reads the
    // password from stdin (fed by spawnCapture, never argv).
    ({ stdout } = await spawnCapture(sz, args, { password }));
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
  if (enforceTotalSize) {
    let total = 0;
    const sizeRe = /^Size = (\d+)/gm;
    let m: RegExpExecArray | null;
    while ((m = sizeRe.exec(stdout)) !== null) {
      total = checkTotalSize(total, parseInt(m[1], 10) || 0);
    }
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

  await preflightSystem7z(sz, options.inputPath, options.password ?? "");

  // Stage on the SAME filesystem as the output dir so the post-extraction move
  // is an atomic same-device rename. Using os.tmpdir() breaks whenever /tmp is a
  // separate mount/tmpfs (common on Linux): renameSync then fails with EXDEV.
  const stagingParent = path.dirname(path.resolve(options.outputDir));
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingParent, ".sa7z_"));

  const args: string[] = ["x", `-o${stagingDir}`, "-mmt=on"];

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
    // No -p switch: 7z prompts for the password and run7z feeds it via stdin.
    await run7z(sz, args, progress, token, undefined, options.password);
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

/**
 * System 7-Zip selective extraction (webview "Extract Selected" / copy-paste).
 * Streams from disk, so large archives (notably RAR) do not need to be loaded
 * into WASM memory. Non-wrapped formats only; wrapped formats keep the WASM path.
 */
export async function extractSelectedWithSystem7z(
  archivePath: string,
  selectedPaths: string[],
  password: string | undefined,
  flat: boolean | undefined,
  outputDir: string,
  excludes: string[] | undefined,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<void> {
  const sz = system7zForExt(getFullExt(archivePath));
  if (!sz) throw new Error("System 7-Zip not available");

  // Symlink entries are refused before extraction (path-traversal write-through
  // happens DURING extraction). Total-size enforcement is skipped here because
  // only the selected entries are extracted, not the whole archive.
  await preflightSystem7z(sz, archivePath, password ?? "", false);

  // Stage on the SAME filesystem as the output dir so the post-extraction move
  // is an atomic same-device rename.
  const stagingParent = path.dirname(path.resolve(outputDir));
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingParent, ".sa7zs_"));

  const args: string[] = [flat ? "e" : "x", archivePath, `-o${stagingDir}`];
  if (flat) args.push("-aou");
  else args.push("-y");
  for (const ex of excludes ?? []) {
    args.push("-xr!" + ex.replace(/\\/g, "/"));
  }
  args.push("--");
  for (const p of selectedPaths) {
    args.push(sanitizeCliPath(p.replace(/\\/g, "/")));
  }

  logger.info({
    event: "system7z.selective.start",
    input: archivePath,
    output: outputDir,
    staging: stagingDir,
    pathCount: selectedPaths.length,
    flat: !!flat,
    argsPreview: maskArgs(args),
  });

  try {
    // No -p switch: 7z prompts for the password and run7z feeds it via stdin.
    await run7z(sz, args, progress, token, undefined, password);
    verifyStagingDir(stagingDir);
    moveMerge(stagingDir, outputDir);
    logger.info({ event: "system7z.selective.ok", output: outputDir });
  } catch (err) {
    logger.error(
      { event: "system7z.selective.failed", err },
      "System 7z selective extraction failed",
    );
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

/**
 * Unwrap inner .tar files after a system-7z extraction using 7-Zip itself,
 * instead of loading each tar into the WASM worker. Mirrors the worker's
 * depth/count limits and keeps the symlink + total-size guards.
 */
export async function unwrapInnerTarsWithSystem7z(
  outputDir: string,
  progress?: ProgressLike,
  token?: TokenLike,
): Promise<void> {
  const sz = system7zForExt(".tar");
  if (!sz) throw new Error("System 7-Zip not available");

  let entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");
  if (entries.length === 0) return;

  let depth = 0;
  let tarCount = 0;
  let totalSize = 0;

  while (depth < UNWRAP_MAX_DEPTH) {
    depth++;
    const tarFiles = entries.filter((e) => TAR_INNER_PATTERNS.some((ext) => e.endsWith(ext)));
    if (tarFiles.length === 0) break;

    for (const tarFile of tarFiles) {
      if (token?.isCancellationRequested) throw new CancelledError();
      tarCount++;
      if (tarCount > UNWRAP_MAX_TAR_FILES) {
        logger.warn(
          { event: "system7z.unwrap.tooManyTars", tarCount, maxTarFiles: UNWRAP_MAX_TAR_FILES },
          "Too many inner tar files, stopping unwrap",
        );
        return;
      }

      const tarPath = path.join(outputDir, tarFile);
      progress?.report({ message: t("decompress.unwrapTar") });

      await preflightSystem7z(sz, tarPath, "", false);
      const stagingDir = fs.mkdtempSync(path.join(outputDir, ".sa7zu_"));
      try {
        await run7z(sz, ["x", tarPath, `-o${stagingDir}`, "-y"], progress, token);
        verifyStagingDir(stagingDir);
        let tarTotal = 0;
        for (const item of walkDir(stagingDir)) {
          if (!item.symlink) tarTotal += fs.statSync(item.path).size;
        }
        totalSize = checkTotalSize(totalSize, tarTotal);
        moveMerge(stagingDir, outputDir);
      } finally {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch {}
      }

      try {
        fs.unlinkSync(tarPath);
      } catch (err) {
        logger.warn(
          { event: "system7z.unwrap.unlinkFailed", path: tarPath, err },
          "Failed to remove intermediate tar archive",
        );
      }
    }

    entries = fs.readdirSync(outputDir).filter((e) => e !== "." && e !== "..");
  }
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
  args.push(filePath);

  logger.info({
    event: "system7z.list.start",
    file: filePath,
    encrypted: !!password,
    args: args.filter((a) => !a.startsWith("-p")).join(" "),
  });

  // No -p switch: 7z prompts for the password and spawnCapture feeds it via
  // stdin when the archive is encrypted.
  const { stdout } = await spawnCapture(sz, args, { password });
  const results = parse7zListing(stdout, archiveName, filePath);

  logger.debug({ event: "system7z.list.ok", count: results.length });
  return results;
}

// ── Encryption detection ─────────────────────────────────────────────

export async function isEncryptedSystem7z(filePath: string): Promise<boolean> {
  const sz = system7zForExt(getFullExt(filePath));
  if (!sz) throw new Error("System 7-Zip not available");

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

/**
 * Integrity-test an archive with the system 7-Zip binary. Streams from disk
 * and never loads the whole archive into WASM memory.
 */
export async function testArchiveWithSystem7z(
  archivePath: string,
  password?: string,
): Promise<string> {
  const sz = system7zForExt(getFullExt(archivePath));
  if (!sz) throw new Error("System 7-Zip not available");

  logger.info({
    event: "system7z.test.start",
    archivePath,
    encrypted: !!password,
  });

  // No -p switch: 7z prompts for the archive password and spawnCapture feeds
  // it via stdin (never argv). Large archives can take a while, so use the
  // same long timeout as run7z instead of the short capture default.
  const { stdout } = await spawnCapture(sz, ["t", archivePath], {
    password,
    timeoutMs: RUN7Z_TIMEOUT,
  });
  const ok = stdout.includes("Everything is Ok");
  logger.info({ event: "system7z.test.ok", archivePath, passed: ok });
  return ok ? t("test.passed") : t("test.warnings") + stdout.slice(-200);
}

// ── Shared spawn utilities ───────────────────────────────────────────

interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Mask -p switches for safe logging (passwords never appear in args). */
function maskArgs(args: string[]): string {
  return args.map((a) => (a.startsWith("-p") ? "-p***" : a)).join(" ");
}

interface SpawnCaptureOpts {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Password to feed to 7z via stdin. Never placed on the command line:
   * 7-Zip prompts for the password when it needs one, and reads the line
   * from stdin. Callers must omit the `-p` switch entirely for open-style
   * operations (l/t/x/d/rn/a on an existing archive); for create-style
   * operations pass an empty `-p` switch to trigger the prompt.
   */
  password?: string;
}

export function spawnCapture(
  binary: string,
  args: string[],
  opts?: number | SpawnCaptureOpts,
): Promise<CaptureResult> {
  const normalized: SpawnCaptureOpts =
    typeof opts === "number" ? { timeoutMs: opts } : { timeoutMs: SPAWN_CAPTURE_TIMEOUT, ...opts };
  const { cwd, timeoutMs, password } = normalized;

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

    // Feed the password via stdin when one is provided (never argv), then
    // close stdin immediately so a stray prompt can never hang the child.
    // Encryption detection intentionally passes no password: an empty
    // stdin makes `-p` (empty switch) fail fast on header-encrypted 7z.
    if (password) {
      validatePassword(password);
      proc.stdin?.write(password + "\n");
    }
    proc.stdin?.end();

    const MAX_CAPTURE_BYTES = CHILD_CAPTURE_MAX_BYTES;
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
      logger.error({ event: "system7z.spawn.failed", binary, err }, "Failed to spawn 7z");
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
const SIZE_MONITOR_INTERVAL_MS = 200;

/**
 * Sum the on-disk bytes of compress targets (files + directory trees).
 * Used as the denominator for file-size-based progress estimation.
 * Symlinks are followed via statSync; unreadable entries are skipped.
 */
function sumTargetBytes(targets: readonly { fsPath: string }[]): number {
  let total = 0;
  const stack = [...targets];
  while (stack.length > 0) {
    const p = stack.pop()!.fsPath;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(p)) stack.push({ fsPath: path.join(p, e) });
      } else {
        total += st.size;
      }
    } catch {
      // best effort — an unreadable entry just skews the estimate
    }
  }
  return total;
}

/**
 * Progress fallback for `7z a`: modern 7-Zip (>= 22) suppresses live
 * percentage output when stderr is not a console, so stderr parsing alone
 * never yields progress. Monitor the output archive's growth on disk
 * instead. Takes effect only until a real `%` from stderr arrives.
 */
function startSizeMonitor(
  outputPath: string,
  totalInputBytes: number,
  prog: ProgressLike,
  isSettled: () => boolean,
  sawRealPct: () => boolean,
): ReturnType<typeof setInterval> | null {
  if (totalInputBytes <= 0) {
    logger.info({
      event: "system7z.sizeMonitor.skip",
      reason: "totalInputBytes<=0",
      outputPath,
      totalInputBytes,
    });
    return null;
  }
  logger.info({
    event: "system7z.sizeMonitor.start",
    outputPath,
    totalInputBytes,
  });
  let lastPct = 0;
  return setInterval(() => {
    if (isSettled() || sawRealPct()) return;
    let bytes = 0;
    try {
      // Non-volume: the archive itself. Volume mode (-v): the base file is
      // never created; 7-Zip writes <base>.NNN for completed volumes and
      // keeps the volume currently being written as <base>.NNN.tmp (the
      // first volume stays .001.tmp until the whole set is finished).
      // Scan both so a stale/empty base file can never block progress.
      try {
        const st = fs.statSync(outputPath);
        if (st.isFile()) bytes += st.size;
      } catch {
        // no base archive in volume mode
      }
      const dir = path.dirname(outputPath);
      const prefix = `${path.basename(outputPath)}.`;
      const volumeSuffixRe = /^\d{3}(\.tmp)?$/;
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const suffix = name.slice(prefix.length);
        if (!volumeSuffixRe.test(suffix)) continue;
        const vol = fs.statSync(path.join(dir, name));
        if (vol.isFile()) bytes += vol.size;
      }
    } catch {
      return;
    }
    if (bytes <= 0) return;
    const pct = Math.min(99, Math.floor((bytes / totalInputBytes) * 100));
    if (pct !== lastPct && pct > 0) {
      const delta = pct - lastPct;
      lastPct = pct;
      logger.info({ event: "system7z.sizeMonitor.pct", bytes, pct });
      prog.report({ message: `${pct}%`, increment: delta });
    }
  }, SIZE_MONITOR_INTERVAL_MS);
}

function run7z(
  binary: string,
  args: string[],
  progress?: ProgressLike,
  token?: TokenLike,
  cwd?: string,
  /** Password to feed via stdin — never appears on the command line. */
  password?: string,
  monitorOutput?: { outputPath: string; totalInputBytes: number },
): Promise<void> {
  const rawProg = progress ?? { report: () => {} };
  // Track cumulative reported percentage: fast/small operations may finish
  // before any intermediate % is parsed or the size monitor ticks, so we can
  // still land the bar on 100% at completion.
  let reportedPct = 0;
  const prog: ProgressLike = {
    report(r) {
      if (typeof r.increment === "number" && r.increment > 0) {
        reportedPct = Math.min(100, reportedPct + r.increment);
      }
      rawProg.report(r);
    },
  };
  return new Promise<void>((resolve, reject) => {
    const combinedChunks: Buffer[] = [];
    let lastPct = -1;
    let sawRealPct = false;
    const startTime = Date.now();
    let settled = false;

    logger.debug({ event: "system7z.run.start", binary, argsPreview: maskArgs(args) });

    const proc = spawn(binary, args, {
      stdio: "pipe",
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });

    // Feed the password via stdin (never argv), then close stdin so a
    // stray prompt cannot hang the child.
    if (password) {
      validatePassword(password);
      proc.stdin?.write(password + "\n");
    }
    proc.stdin?.end();

    const MAX_RUN_BYTES = CHILD_CAPTURE_MAX_BYTES;
    let runBytes = 0;

    const timeoutTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        stopSizeMonitor();
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

    const sizeTimer =
      monitorOutput && progress
        ? startSizeMonitor(
            monitorOutput.outputPath,
            monitorOutput.totalInputBytes,
            prog,
            () => settled,
            () => sawRealPct,
          )
        : null;
    logger.info({
      event: "system7z.run.monitor",
      started: !!sizeTimer,
      monitorOutput: !!monitorOutput,
      hasProgress: !!progress,
    });
    const stopSizeMonitor = () => {
      if (sizeTimer) clearInterval(sizeTimer);
    };

    proc.stdout?.on("data", (d: Buffer) => {
      combinedChunks.push(d);
      runBytes += d.length;
      if (runBytes > MAX_RUN_BYTES) {
        proc.kill();
        settled = true;
        stopSizeMonitor();
        clearTimeout(timeoutTimer);
        cancelSub?.dispose();
        reject(new Error("7z output exceeded 500 MB limit"));
        return;
      }

      // With -bsp1 (compress) progress is streamed to stdout as
      // " 45% 12 - file.txt" with backspace overprints; parse it exactly
      // like stderr so the bar advances on 7-Zip versions that suppress
      // console output when piped.
      const text = decodeBuffer(d);
      const m = text.match(/(\d{1,3})%/);
      if (m) {
        const pct = parseInt(m[1], 10);
        if (pct !== lastPct && pct > 0) {
          const delta = pct - (lastPct < 0 ? 0 : lastPct);
          lastPct = pct;
          sawRealPct = true;
          prog.report({ message: `${pct}%`, increment: delta });
        }
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const text = decodeBuffer(d);
      combinedChunks.push(d);
      runBytes += d.length;
      if (runBytes > MAX_RUN_BYTES) {
        proc.kill();
        settled = true;
        stopSizeMonitor();
        clearTimeout(timeoutTimer);
        cancelSub?.dispose();
        reject(new Error("7z output exceeded 500 MB limit"));
        return;
      }

      // Parse progress: 7z outputs lines like " 45% 12 - file.txt" to stderr
      // Report the increment (like the WASM engine path) so VS Code renders
      // a determinate progress bar instead of an indeterminate spinner.
      const m = text.match(/(\d{1,3})%/);
      if (m) {
        const pct = parseInt(m[1], 10);
        if (pct !== lastPct && pct > 0) {
          const delta = pct - (lastPct < 0 ? 0 : lastPct);
          lastPct = pct;
          sawRealPct = true;
          prog.report({ message: `${pct}%`, increment: delta });
        }
      }
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      stopSizeMonitor();
      clearTimeout(timeoutTimer);
      cancelSub?.dispose();
      const elapsed = Date.now() - startTime;
      logger.error(
        {
          event: "system7z.run.failed",
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
      stopSizeMonitor();
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
        if (progress && reportedPct < 100) {
          prog.report({ message: "100%", increment: 100 - reportedPct });
        }
        logger.info(logMeta);
        resolve();
        return;
      }

      // 7-Zip exit code 1 means "Warning (Non fatal error(s))" per official docs.
      // Some files may have failed but the archive was processed successfully.
      // This is not a fatal error, so resolve rather than reject.
      if (code === 1) {
        if (progress && reportedPct < 100) {
          prog.report({ message: "100%", increment: 100 - reportedPct });
        }
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
    args.push("*");

    logger.info({
      event: "system7z.add.start",
      archivePath,
      files: addedCount,
      targetDir: normDir || "(root)",
      encrypted: !!password,
    });

    // No -p switch: adding to an existing encrypted archive prompts for its
    // password and spawnCapture feeds it via stdin (never argv).
    await spawnCaptureInCwd(sz, args, tmpRoot, SPAWN_CAPTURE_TIMEOUT, password);

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
  password?: string,
): Promise<CaptureResult> {
  return spawnCapture(binary, args, { cwd, timeoutMs, password });
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
  // No -p switch: 7z prompts for the archive password; run7z feeds it via stdin.
  await run7z(sz, dArgs, progress, token, path.dirname(archivePath), password);

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

  logger.info({
    event: "system7z.rename.start",
    archivePath,
    oldPath,
    newPath,
    encrypted: !!password,
  });

  // No -p switch: 7z prompts for the archive password; spawnCapture feeds it
  // via stdin (never argv).
  await spawnCaptureInCwd(sz, rnArgs, path.dirname(archivePath), SPAWN_CAPTURE_TIMEOUT, password);

  logger.info({ event: "system7z.rename.ok", archivePath, oldPath, newPath });
}
