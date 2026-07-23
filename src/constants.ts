/**
 * Constants — Smart Archive VSCode Extension
 *
 * Single source of truth for all archive format metadata.
 * Every supported format is defined as one row in FORMAT_TABLE;
 * all derived exports (lists, sets, patterns) are computed from it.
 * To add or change a format, modify only FORMAT_TABLE.
 *
 * @module constants
 */

import type { FormatInfo } from "./types";
import * as path from "path";
import * as fs from "fs";
import { isRarExt } from "./utils/rar";

// ════════════════════════════════════════════════════════════════════
// Format table — one row per supported archive format
// ════════════════════════════════════════════════════════════════════

export interface FormatMeta {
  /** All file extensions mapped to this format (compound-first) */
  exts: string[];
  /** Display label for UI */
  label: string;
  /** Human-readable description */
  description: string;
  /** Can create (compress) this format */
  canCreate: boolean;
  /** Supports AES-256 encryption */
  supportsEncryption: boolean;
  /** Category: direct, wrapped (tar.zst, etc.), or special (WIM/RAR) */
  category: "direct" | "wrapped" | "stream" | "special";
  /** 7z callMain supports selective extraction with file paths */
  j7zSelective: boolean;
  /** Whether the format wraps a tar (tar.gz, .tgz etc.); requires two-step creation */
  wrapsTar: boolean;
  /** Inner tar compression extension when creating wrapped formats; null for non-wrapped */
  wrapCompression: string | null;
  /** Short-form aliases of `tar.<compression>` (e.g. .tgz = tar.gz) */
  shortAliases: Record<string, string>;
}

export const FORMAT_TABLE: FormatMeta[] = [
  {
    exts: [".7z"],
    label: "7z",
    description: "7-Zip — best compression ratio, AES-256 encryption, solid archive",
    canCreate: true,
    supportsEncryption: true,
    category: "direct",
    j7zSelective: true,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  {
    exts: [".zip"],
    label: "zip",
    description: "ZIP — universal compatibility, AES-256 encryption",
    canCreate: true,
    supportsEncryption: true,
    category: "direct",
    j7zSelective: true,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  {
    exts: [".tar"],
    label: "tar",
    description: "TAR — archive only, no compression (typically paired with gz/xz)",
    canCreate: true,
    supportsEncryption: false,
    category: "direct",
    j7zSelective: true,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  {
    exts: [".gz"],
    label: "gz",
    description: "GZip — single-file compression (auto-wraps in TAR for folders)",
    canCreate: false,
    supportsEncryption: false,
    category: "stream",
    j7zSelective: true,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  {
    exts: [".bz2"],
    label: "bz2",
    description: "BZip2 — high compression for single files (auto-wraps in TAR for folders)",
    canCreate: false,
    supportsEncryption: false,
    category: "stream",
    j7zSelective: true,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  {
    exts: [".xz"],
    label: "xz",
    description: "XZ — high compression for single files (auto-wraps in TAR for folders)",
    canCreate: false,
    supportsEncryption: false,
    category: "stream",
    j7zSelective: true,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  {
    exts: [".tar.gz", ".tgz"],
    label: "tar.gz",
    description: "TAR + GZip — compressed archive with directory structure",
    canCreate: true,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "gz",
    shortAliases: { ".tgz": "tar.gz" },
  },
  {
    exts: [".tar.bz2", ".tbz2", ".tbz"],
    label: "tar.bz2",
    description: "TAR + BZip2 — high compression with directory structure",
    canCreate: true,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "bz2",
    shortAliases: { ".tbz2": "tar.bz2", ".tbz": "tar.bz2" },
  },
  {
    exts: [".tar.xz", ".txz"],
    label: "tar.xz",
    description: "TAR + XZ — best compression with directory structure",
    canCreate: true,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "xz",
    shortAliases: { ".txz": "tar.xz" },
  },
  {
    exts: [".tar.zst", ".tzst"],
    label: "tar.zst",
    description: "TAR + Zstandard — fast compression with directory structure",
    canCreate: true,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "zst",
    shortAliases: { ".tzst": "tar.zst" },
  },
  {
    exts: [".tar.lz", ".tlz"],
    label: "tar.lz",
    description: "TAR + Lzip — extraction only (creation unavailable in WASM)",
    canCreate: false,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "lz",
    shortAliases: { ".tlz": "tar.lz" },
  },
  {
    exts: [".tar.lzma"],
    label: "tar.lzma",
    description: "TAR + LZMA — extraction only (creation unavailable in WASM)",
    canCreate: false,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "lzma",
    shortAliases: {},
  },
  {
    exts: [".tar.lz4", ".tlz4"],
    label: "tar.lz4",
    description: "TAR + LZ4 — fast compression with directory structure",
    canCreate: true,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "lz4",
    shortAliases: { ".tlz4": "tar.lz4" },
  },
  {
    exts: [".tar.br", ".tbr"],
    label: "tar.br",
    description: "TAR + Brotli — high compression ratio with directory structure",
    canCreate: true,
    supportsEncryption: false,
    category: "wrapped",
    j7zSelective: false,
    wrapsTar: true,
    wrapCompression: "br",
    shortAliases: { ".tbr": "tar.br" },
  },
  {
    exts: [".rar"],
    label: "rar",
    description: "RAR — extraction only (creation unavailable)",
    canCreate: false,
    supportsEncryption: true,
    category: "special",
    j7zSelective: false,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  {
    exts: [".wim"],
    label: "wim",
    description: "WIM — Windows Imaging Format",
    canCreate: true,
    supportsEncryption: false,
    category: "special",
    j7zSelective: true,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  },
  // ── Extraction-only formats (7z can read but not create) ──
  ...(
    [
      [".cab"],
      [".arj"],
      [".lzh"],
      [".chm"],
      [".msi"],
      [".z"],
      [".cpio"],
      [".rpm"],
      [".deb"],
      [".uha"],
      [".xar"],
      [".iso"],
      [".vhd"],
      [".vmdk"],
      [".fat"],
      [".ntfs"],
      [".squashfs"],
      [".dmg"],
      [".hfs"],
      [".apm"],
      [".mbr"],
      [".elf"],
      [".macho"],
      [".swf"],
      [".flv"],
    ] as const
  ).map(([ext]) => ({
    exts: [ext],
    label: ext.slice(1),
    description: `${ext} — extraction only`,
    canCreate: false,
    supportsEncryption: false,
    category: "special" as const,
    j7zSelective: false,
    wrapsTar: false,
    wrapCompression: null,
    shortAliases: {},
  })),
];

// ════════════════════════════════════════════════════════════════════
// Derived exports (backward-compatible with existing code)
// ════════════════════════════════════════════════════════════════════

/** All extensions that the extension can read/extract */
export const DECOMPRESS_EXTENSIONS: readonly string[] = FORMAT_TABLE.flatMap((f) => f.exts);

/** Formats available for compression (canCreate === true) */
export const COMPRESS_FORMATS: FormatInfo[] = FORMAT_TABLE.filter((f) => f.canCreate).map(
  (f): FormatInfo => ({
    label: f.label,
    description: f.description,
    canCreate: f.canCreate,
    supportsEncryption: f.supportsEncryption,
  }),
);

/** Regex for RAR-family extensions (including multi-volume .r00–.r99) */
export { isRarExt } from "./utils/rar";

/** Extensions that may contain encrypted data (7z/ZIP/RAR) */
export const ENCRYPTABLE_EXTS: readonly string[] = FORMAT_TABLE.filter(
  (f) => f.supportsEncryption,
).flatMap((f) => f.exts);

/** Compound extensions that take priority over simple path.extname() (long forms before short) */
export const COMPOUND_EXTS: readonly string[] = FORMAT_TABLE.filter((f) => f.wrapsTar).flatMap(
  (f) => f.exts,
);

/** Set of extensions where 7z supports selective extraction */
export const J7Z_SELECTIVE_EXTS: ReadonlySet<string> = new Set(
  FORMAT_TABLE.filter((f) => f.j7zSelective).flatMap((f) => f.exts),
);

/** Map short-form extension to canonical long-form (e.g. .tgz → .tar.gz) */
export const SHORT_EXT_MAP: ReadonlyMap<string, string> = new Map(
  FORMAT_TABLE.flatMap((f) => Object.entries(f.shortAliases)),
);

// ════════════════════════════════════════════════════════════════════
// Convenience lookups (pre-built for O(1) access)
// ════════════════════════════════════════════════════════════════════

const FORMAT_MAP = new Map<string, FormatMeta>();
for (const f of FORMAT_TABLE) {
  for (const ext of f.exts) {
    FORMAT_MAP.set(ext, f);
  }
}

const ENCRYPTABLE_EXTS_SET = new Set(ENCRYPTABLE_EXTS);

export function getFormatByExt(ext: string): FormatMeta | undefined {
  return FORMAT_MAP.get(ext.toLowerCase());
}

export function getFullExt(filePath: string): string {
  const lower = filePath.toLowerCase();

  // Split volumes: archive.7z.001 → .7z, archive.zip.002 → .zip
  const volMatch = lower.match(/\.(7z|zip|wim)\.\d+$/);
  if (volMatch) return volMatch[0].replace(/\.\d+$/, "");

  for (const ext of COMPOUND_EXTS) {
    if (lower.endsWith(ext)) return ext;
  }
  return path.extname(filePath).toLowerCase();
}

export function isSplitVolume(filePath: string): boolean {
  return (
    /\.(7z|zip|wim)\.\d+$/i.test(filePath) ||
    /\.part\d+\.rar$/i.test(filePath) ||
    /\.r\d{2}$/i.test(filePath)
  );
}

/**
 * For a split volume file like "archive.7z.001", returns the base archive
 * name "archive.7z". Returns null if not a recognised split-volume pattern.
 */
export function getSplitVolumeBase(fileName: string): string | null {
  // Standard split volumes: archive.7z.001, archive.zip.001, archive.wim.001
  const m = fileName.match(/(.+\.(?:7z|zip|wim))\.\d+$/i);
  if (m) return m[1];
  // RAR split volumes: archive.part1.rar
  const rarPart = fileName.match(/^(.+)\.part\d+\.rar$/i);
  if (rarPart) return rarPart[1];
  // RAR old-style: archive.r00
  const rarOld = fileName.match(/^(.+)\.r\d{2}$/i);
  if (rarOld) return rarOld[1];
  return null;
}

/**
 * Strip the split-volume number suffix (e.g. "archive.7z.001" → "archive.7z").
 * Returns the original path unchanged if no volume suffix is detected.
 */
export function removeVolumeSuffix(filePath: string): string {
  return filePath.replace(/\.\d+$/, "");
}

/**
 * For a 7z/zip/wim split volume like archive.7z.002, locates the first
 * volume (archive.7z.001) if it exists in the same directory.
 * Returns null if the .001 file does not exist.
 */
export function resolveSplitVolume(filePath: string): string | null {
  const base = getSplitVolumeBase(path.basename(filePath));
  if (!base) return null;
  const dir = path.dirname(filePath);
  const target = path.join(dir, base + ".001");
  return fs.existsSync(target) ? target : null;
}

export function isWrappedFormat(ext: string): boolean {
  const f = getFormatByExt(ext);
  return f?.wrapsTar ?? false;
}

export function getWrapExtension(ext: string): string {
  const f = getFormatByExt(ext);
  return f?.wrapCompression ?? "";
}

export function isEncryptableExt(ext: string): boolean {
  return ENCRYPTABLE_EXTS_SET.has(ext.toLowerCase());
}

// ── Noisy directory patterns (collapsed by default in preview) ─────

export const NOISY_DIR_PATTERNS = [
  // JavaScript / Node
  "node_modules",
  ".npm",
  ".yarn",
  // Python
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".eggs",
  "site-packages",
  // VCS
  ".git",
  ".svn",
  ".hg",
  // Build outputs
  "dist",
  "build",
  "target",
  "out",
  "output",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  // IDE / editors
  ".idea",
  ".vscode",
  ".vs",
  // Coverage / testing
  "coverage",
  ".nyc_output",
  // Cache
  ".cache",
  ".turbo",
  ".parcel-cache",
  // Other dependency dirs
  "vendor",
  "bower_components",
  // Infrastructure
  ".terraform",
];

// ── Default compression exclude patterns ────────────────────────────

export const COMPRESS_EXCLUDE_DEFAULTS = NOISY_DIR_PATTERNS;

// ── Shared operational constants ────────────────────────────────────

/** Codec compression/decompression chunk size (50 MB) */
export const CODEC_CHUNK = 50 * 1024 * 1024;
/** VFS I/O chunk size (100 MB) */
export const VFS_CHUNK = 100 * 1024 * 1024;
/** Max collision resolution retries for unique path generation */
export const MAX_COLLISION_RETRIES = 999;
/** spawnSync timeout for binary detection (ms) */
export const BINARY_DETECT_TIMEOUT = 5000;
/** default spawnCapture timeout (ms) */
export const SPAWN_CAPTURE_TIMEOUT = 30_000;
