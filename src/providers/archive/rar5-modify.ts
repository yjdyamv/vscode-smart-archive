/**
 * Rebuild-based RAR archive modification — Smart Archiver VSCode Extension
 *
 * 7-Zip (and the WASM fallback) can read/extract RAR archives but cannot
 * modify them (`E_NOTIMPL`). RAR modification is therefore implemented as
 * a rebuild: extract the whole archive with system 7-Zip → mutate the
 * extracted tree (delete / rename / new folder / add files) → re-create
 * the archive with the rar5 native engine → atomically replace the
 * original file.
 *
 * Supported: single-volume RAR5 archives, including password-protected
 * ones (re-encrypted with the same password). RAR4 archives are rebuilt
 * as RAR5 after an explicit user confirmation; multi-volume archives are
 * rejected up front with a clear message instead of an opaque 7-Zip
 * error.
 *
 * @module providers/archive/rar5-modify
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getFullExt } from "../../constants";
import { isRarExt, isRarVolume } from "../../utils/rar";
import { isPathExcluded, type ExclusionSet } from "../../utils/exclude";
import { logger } from "../../utils/logger";
import { t } from "../../i18n";
import { decompressWithSystem7z } from "../../engines/system7z";
import { compressWithRar5 } from "../../engines/rar5-engine";
import type { ProgressLike, TokenLike } from "../../utils/cancellation";
import type { FormatInfo } from "../../types";

const RAR5_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR4_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

const RAR5_FORMAT: FormatInfo = {
  label: "rar",
  description: "RAR5 — native creation with AES-256 encryption (no external tools)",
  canCreate: true,
  supportsEncryption: true,
};

/**
 * Reject archives the rebuild cannot faithfully reproduce (multi-volume,
 * non-RAR input). RAR4 is allowed here — it is converted to RAR5 after an
 * explicit user confirmation in `rebuildRarArchive`.
 */
export function assertRarModifiable(archivePath: string): void {
  const ext = getFullExt(archivePath);
  if (!isRarExt(ext)) {
    throw new Error(`Not a RAR archive: ${archivePath}`);
  }
  if (isRarVolume(ext) || /\.part\d+\.rar$/i.test(archivePath)) {
    logger.info({ event: "rar5.rebuild.multivolumeRejected", archivePath, ext });
    throw new Error(t("rar5.modifyMultivolume"));
  }
}

/** Sniff the RAR signature: "rar5" | "rar4" | "unknown". */
export function detectRarVersion(archivePath: string): "rar5" | "rar4" | "unknown" {
  const fd = fs.openSync(archivePath, "r");
  try {
    const head = Buffer.alloc(8);
    const n = fs.readSync(fd, head, 0, 8, 0);
    if (n >= 8 && head.equals(RAR5_SIGNATURE)) return "rar5";
    if (n >= 7 && head.subarray(0, 7).equals(RAR4_SIGNATURE)) return "rar4";
    return "unknown";
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Sniff whether a RAR5 archive encrypts its headers (hidden file names).
 *
 * With header encryption the archive-level encryption header (block type 4)
 * is the first block right after the signature, before the main archive
 * header. Block layout: `[crc32 (4)] [header-size vint] [block-type vint]`.
 */
export function hasEncryptedHeaders(archivePath: string): boolean {
  const fd = fs.openSync(archivePath, "r");
  try {
    const buf = Buffer.alloc(32);
    const n = fs.readSync(fd, buf, 0, 32, 8);
    if (n < 5) return false;
    let pos = 4; // skip crc32
    const readVint = (): number | null => {
      let val = 0;
      let shift = 0;
      while (pos < n) {
        const b = buf[pos++];
        val |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return val;
        shift += 7;
        if (shift > 56) return null;
      }
      return null;
    };
    const hsize = readVint();
    if (hsize === null) return false;
    const blockType = readVint();
    return blockType === 4;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Join an archive-relative path (e.g. `dir/file.txt`) onto the extraction
 * root, rejecting any path that escapes the root.
 */
export function archiveJoin(root: string, relPath: string): string {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relPath.replace(/\\/g, "/"));
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error(t("security.pathTraversal"));
  }
  return target;
}

/**
 * Copy a file or directory into the archive tree being rebuilt, filtering
 * directory children with the same exclusion patterns the add-to-archive
 * flow applies to other formats.
 */
export function copyIntoArchive(destDir: string, src: string, exclusions: ExclusionSet): void {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    copyDirFiltered(src, dest, exclusions);
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dest);
    logger.debug({ event: "rar5.rebuild.copy", src, dest });
  }
}

function copyDirFiltered(srcDir: string, destDir: string, exclusions: ExclusionSet): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const child of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (isPathExcluded(child.name, exclusions)) continue;
    const src = path.join(srcDir, child.name);
    const dst = path.join(destDir, child.name);
    if (child.isDirectory()) {
      copyDirFiltered(src, dst, exclusions);
    } else if (child.isFile()) {
      fs.copyFileSync(src, dst);
      logger.debug({ event: "rar5.rebuild.copy", src, dst });
    }
  }
}

/**
 * Sniff the recovery-record percent of a RAR5 archive (0-100) by locating
 * the "RR" service header and reading its service-data record. Returns
 * undefined when the archive has no (readable) recovery record.
 */
export function readRecoveryPercent(archivePath: string): number | undefined {
  const fd = fs.openSync(archivePath, "r");
  try {
    const readVintAt = (pos: number): { value: number; len: number } | null => {
      let val = 0;
      let shift = 0;
      const buf = Buffer.alloc(10);
      const n = fs.readSync(fd, buf, 0, 10, pos);
      for (let i = 0; i < n; i++) {
        const b = buf[i];
        val |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: val, len: i + 1 };
        shift += 7;
        if (shift > 56) return null;
      }
      return null;
    };
    // Walk blocks from the signature to find the RR service header.
    const sig = Buffer.alloc(8);
    if (fs.readSync(fd, sig, 0, 8, 0) < 8 || !sig.equals(RAR5_SIGNATURE)) return undefined;
    let pos = 8;
    while (pos < fs.statSync(archivePath).size && pos > 7) {
      // Header-encrypted archives encrypt every block after the type-0x04
      // encryption header — their headers cannot be sniffed without the
      // password, so treat them as having no readable recovery record.
      const hsize = readVintAt(pos + 4);
      if (!hsize) return undefined;
      const contentStart = pos + 4 + hsize.len;
      const type = readVintAt(contentStart);
      if (!type) return undefined;
      const flags = readVintAt(contentStart + type.len);
      if (!flags) return undefined;
      let p = contentStart + type.len + flags.len;
      let dataSize = 0;
      if (flags.value & 0x0001) {
        const v = readVintAt(p);
        if (!v) return undefined;
        p += v.len;
      }
      if (flags.value & 0x0002) {
        const v = readVintAt(p);
        if (!v) return undefined;
        dataSize = v.value;
        p += v.len;
      }
      if (type.value === 4) return undefined; // encrypted headers — cannot sniff
      if (type.value === 3) {
        // Service header: file flags, unpacked size, attrs, mtime, crc,
        // comp info, host os, name length, name, extra area.
        const fflags = readVintAt(p);
        if (!fflags) return undefined;
        p += fflags.len;
        const usize = readVintAt(p);
        if (!usize) return undefined;
        p += usize.len;
        const attrs = readVintAt(p);
        if (!attrs) return undefined;
        p += attrs.len;
        if (fflags.value & 0x0002) p += 4; // mtime
        if (fflags.value & 0x0004) p += 4; // crc
        const cinfo = readVintAt(p);
        if (!cinfo) return undefined;
        p += cinfo.len;
        const host = readVintAt(p);
        if (!host) return undefined;
        p += host.len;
        const nlen = readVintAt(p);
        if (!nlen) return undefined;
        p += nlen.len;
        const name = Buffer.alloc(nlen.value);
        fs.readSync(fd, name, 0, nlen.value, p);
        if (name.toString("utf8") === "RR") {
          // Service-data record in the extra area: [size][type=0x07][data].
          const recSize = readVintAt(p + nlen.value);
          if (!recSize) return undefined;
          const recType = readVintAt(p + nlen.value + recSize.len);
          if (!recType || recType.value !== 0x07) return undefined;
          const dataByte = Buffer.alloc(1);
          fs.readSync(fd, dataByte, 0, 1, p + nlen.value + recSize.len + recType.len);
          const pct = dataByte[0];
          return pct > 100 ? undefined : pct;
        }
      }
      if (dataSize > fs.statSync(archivePath).size) {
        return undefined; // implausible — malformed header
      }
      const next = contentStart + hsize.value + dataSize;
      if (next <= pos) return undefined; // malformed — no forward progress
      pos = next;
      if (type.value === 5) return undefined; // end of archive
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Size of the RAR5 payload protected by the recovery record — every
 * header and file-data block before the `{RB}` parity tail. The on-disk
 * archive size includes the recovery record, which inflates the
 * compression ratio shown in the archive view. Falls back to `fullSize`
 * when the archive is not RAR5 or has no readable recovery record.
 * Header-encrypted archives cannot be walked (every block header is
 * encrypted), but the `{RB}` chunk data is stored in the clear, so a
 * validated scan recovers the protected size there too.
 */
export function getRarPayloadSize(archivePath: string, fullSize: number): number {
  const fd = fs.openSync(archivePath, "r");
  try {
    const sig = Buffer.alloc(8);
    if (fs.readSync(fd, sig, 0, 8, 0) < 8 || !sig.equals(RAR5_SIGNATURE)) return fullSize;

    // Buffered walk: parse the header blocks from a sliding 1 MiB window
    // instead of one readSync per vint. The header area of any realistic
    // archive fits in one or two reads, so this is O(1) syscalls for the
    // archive-view hot path.
    const CHUNK = 1 << 20;
    const buf = Buffer.alloc(CHUNK);
    let winStart = 0; // file offset of buf[0]
    let winLen = 0; // valid bytes in buf
    const ensure = (from: number, need: number): boolean => {
      if (from >= winStart && from + need <= winStart + winLen) return true;
      winStart = from;
      const n = fs.readSync(fd, buf, 0, CHUNK, winStart);
      winLen = n;
      return from + need <= winStart + winLen;
    };
    const vintAt = (pos: number): { value: number; len: number } | null => {
      let val = 0;
      let shift = 0;
      for (let i = 0; i < 10; i++) {
        if (!ensure(pos + i, 1)) return null;
        const b = buf[pos + i - winStart];
        val |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: val, len: i + 1 };
        shift += 7;
        if (shift > 56) return null;
      }
      return null;
    };
    const byteAt = (pos: number): number | null => {
      if (!ensure(pos, 1)) return null;
      return buf[pos - winStart];
    };

    let pos = 8;
    while (pos < fullSize && pos > 7) {
      const hsize = vintAt(pos + 4);
      if (!hsize) return fullSize;
      const contentStart = pos + 4 + hsize.len;
      const type = vintAt(contentStart);
      if (!type) return fullSize;
      const flags = vintAt(contentStart + type.len);
      if (!flags) return fullSize;
      let p = contentStart + type.len + flags.len;
      let dataSize = 0;
      if (flags.value & 0x0001) {
        const v = vintAt(p);
        if (!v) return fullSize;
        p += v.len;
      }
      if (flags.value & 0x0002) {
        const v = vintAt(p);
        if (!v) return fullSize;
        dataSize = v.value;
        p += v.len;
      }
      if (type.value === 4) {
        // Header-encrypted archives hide every block header, so the walk
        // cannot proceed. The recovery-record {RB} chunk data is stored in
        // the clear (only the RR service header is encrypted), so scan for
        // a structurally valid chunk and read its protected_size.
        return scanRarPayloadSize(fd, fullSize) ?? fullSize;
      }
      if (type.value === 3) {
        const fflags = vintAt(p);
        if (!fflags) return fullSize;
        p += fflags.len;
        const usize = vintAt(p);
        if (!usize) return fullSize;
        p += usize.len;
        const attrs = vintAt(p);
        if (!attrs) return fullSize;
        p += attrs.len;
        if (fflags.value & 0x0002) p += 4; // mtime
        if (fflags.value & 0x0004) p += 4; // crc
        const cinfo = vintAt(p);
        if (!cinfo) return fullSize;
        p += cinfo.len;
        const host = vintAt(p);
        if (!host) return fullSize;
        p += host.len;
        const nlen = vintAt(p);
        if (!nlen) return fullSize;
        p += nlen.len;
        if (nlen.value >= 2 && nlen.value <= 8 && byteAt(p) === 0x52 && byteAt(p + 1) === 0x52) {
          // The {RB} chunk starts at the service block's data area; its
          // protected_size field lives at chunk offset 0x22 (u64 LE).
          const rbStart = contentStart + hsize.value;
          if (!ensure(rbStart + 0x22, 8)) return fullSize;
          const protectedSize = Number(buf.readBigUInt64LE(rbStart + 0x22 - winStart));
          if (protectedSize > 0 && protectedSize <= fullSize) return protectedSize;
          return fullSize;
        }
      }
      if (dataSize > fullSize) return fullSize; // implausible — malformed header
      const next = contentStart + hsize.value + dataSize;
      if (next <= pos) return fullSize; // malformed — no forward progress
      pos = next;
      if (type.value === 5) return fullSize; // end of archive
    }
    return fullSize;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * CRC64/XZ over `data`, mirroring crates/rar/src/recovery/rar5.rs (the
 * reversed bit-order variant: right shift, poly 0xc96c5795d7870f42, init
 * and final xor 0xffffffffffffffff). BigInt is needed for the u64
 * arithmetic.
 */
function crc64Xz(data: Buffer): bigint {
  const POLY = 0xc96c5795d7870f42n;
  let crc = 0xffffffffffffffffn;
  for (const byte of data) {
    crc ^= BigInt(byte);
    for (let i = 0; i < 8; i++) {
      const mask = 0n - (crc & 1n);
      crc = (crc >> 1n) ^ (POLY & mask);
    }
  }
  return crc ^ 0xffffffffffffffffn;
}

/**
 * For header-encrypted archives the block walk cannot see the {RB}
 * recovery chunk (its service header is encrypted), but the chunk data
 * itself is written in the clear. Scan the file for a structurally valid
 * chunk — {RB} marker + header_size/version sanity + the chunk CRC64 —
 * and return its protected_size; `null` when no valid chunk exists.
 */
function scanRarPayloadSize(fd: number, fullSize: number): number | null {
  const MARKER = Buffer.from("{RB}");
  const CHUNK = 1 << 20;
  const buf = Buffer.alloc(CHUNK);
  let base = 0; // file offset of buf[0]
  let len = 0; // valid bytes in buf
  const refill = (from: number): number => {
    base = from;
    len = fs.readSync(fd, buf, 0, CHUNK, from);
    return len;
  };
  const readAt = (from: number, need: number): boolean => {
    if (from >= base && from + need <= base + len) return true;
    refill(from);
    return from + need <= base + len;
  };
  const byteAt = (off: number): number | null => {
    if (!readAt(off, 1)) return null;
    return buf[off - base];
  };
  const u32 = (off: number): number | null => {
    if (!readAt(off, 4)) return null;
    return buf.readUInt32LE(off - base);
  };
  const u64 = (off: number): bigint | null => {
    if (!readAt(off, 8)) return null;
    return buf.readBigUInt64LE(off - base);
  };

  let pos = 8;
  while (pos + 4 <= fullSize) {
    if (refill(pos) < 4) break;
    const idx = buf.indexOf(MARKER, pos - base);
    if (idx === -1) {
      // Keep a 3-byte overlap so a marker straddling the window edge is
      // still caught; stop when the window cannot advance.
      const next = base + len - 3;
      if (next <= pos) break;
      pos = next;
      continue;
    }
    const start = base + idx;
    const totalSize = u32(start + 0x0c);
    const headerSize = u32(start + 0x10);
    const versionOk = byteAt(start + 0x14) === 1 && byteAt(start + 0x15) === 1;
    if (
      totalSize === null ||
      headerSize === null ||
      headerSize < 0x48 ||
      headerSize > totalSize ||
      start + totalSize > fullSize ||
      !versionOk
    ) {
      pos = start + 1;
      continue;
    }
    // CRC64 covers [0x0c .. total_size); a false-positive marker in file
    // data fails it with probability ~2^-64.
    const crcData = Buffer.alloc(totalSize - 0x0c);
    const n = fs.readSync(fd, crcData, 0, crcData.length, start + 0x0c);
    const expected = u64(start + 0x04);
    if (n !== crcData.length || expected === null || crc64Xz(crcData) !== expected) {
      pos = start + 1;
      continue;
    }
    const protectedSize = u64(start + 0x22);
    if (protectedSize === null || protectedSize <= 0n || protectedSize > BigInt(fullSize)) {
      pos = start + 1;
      continue;
    }
    return Number(protectedSize);
  }
  return null;
}

export interface RebuildRarOptions {
  archivePath: string;
  password?: string;
  /** Mutate the extracted tree in place before the archive is re-created. */
  mutate: (root: string) => void | Promise<void>;
  progress?: ProgressLike;
  token?: TokenLike;
  /** 7-Zip-style compression level 0..9 (default 5, the UI default). */
  level?: number;
}

/**
 * Rebuild a RAR5 archive: extract → mutate → re-compress → atomic swap.
 */
export async function rebuildRarArchive(options: RebuildRarOptions): Promise<void> {
  const { archivePath, password = "", mutate, progress, token } = options;
  assertRarModifiable(archivePath);

  const version = detectRarVersion(archivePath);
  if (version === "rar4") {
    // RAR4 cannot be created by the rar5 engine — converting it to RAR5
    // is a format change, so ask the user first.
    const confirm = await vscode.window.showWarningMessage(
      t("rar5.modifyRar4Prompt"),
      { modal: true },
      t("rar5.modifyRar4Confirm"),
    );
    if (confirm !== t("rar5.modifyRar4Confirm")) {
      logger.info({ event: "rar5.rebuild.rar4Declined", archivePath });
      throw new Error(t("rar5.modifyRar4"));
    }
    logger.info({ event: "rar5.rebuild.rar4Convert", archivePath });
  } else if (version !== "rar5") {
    logger.warn({ event: "rar5.rebuild.unknownSignature", archivePath, version });
    throw new Error(t("rar5.modifyNotRar"));
  }

  logger.info({
    event: "rar5.rebuild.start",
    archivePath,
    version,
    encrypted: password.length > 0,
    level: options.level ?? 5,
  });

  const prog = progress ?? { report: () => {} };
  const archiveDir = path.dirname(path.resolve(archivePath));
  fs.mkdirSync(archiveDir, { recursive: true });

  // Work on the same filesystem as the archive so the final swap is an
  // atomic same-device rename (os.tmpdir() can be a separate mount).
  const workRoot = fs.mkdtempSync(path.join(archiveDir, ".sa-rar5-"));
  const extractRoot = path.join(workRoot, "extract");
  const rebuiltPath = path.join(workRoot, "rebuilt.rar");
  fs.mkdirSync(extractRoot, { recursive: true });

  try {
    prog.report({ message: t("rar5.modifyExtracting") });
    await decompressWithSystem7z(
      { inputPath: archivePath, outputDir: extractRoot, password },
      progress,
      token,
    );

    const topLevel = fs
      .readdirSync(extractRoot)
      .filter((n) => n !== "." && n !== "..")
      .sort();
    logger.info({
      event: "rar5.rebuild.extracted",
      archivePath,
      topLevelEntries: topLevel.length,
    });
    if (topLevel.length === 0) {
      logger.warn({ event: "rar5.rebuild.empty", archivePath });
      throw new Error(t("rar5.modifyEmpty"));
    }

    logger.info({ event: "rar5.rebuild.mutate", archivePath });
    prog.report({ message: t("rar5.modifyRebuilding") });
    await mutate(extractRoot);

    // Official `rar d` erases the archive when every member is deleted —
    // repacking an empty archive would instead fail on missing targets.
    const remaining = fs
      .readdirSync(extractRoot)
      .filter((n) => n !== "." && n !== "..")
      .sort();
    if (remaining.length === 0) {
      logger.info({ event: "rar5.rebuild.erased", archivePath });
      fs.rmSync(archivePath, { force: true });
      return;
    }

    await compressWithRar5(
      {
        format: RAR5_FORMAT,
        outputPath: rebuiltPath,
        targets: remaining.map((n) => ({ fsPath: path.join(extractRoot, n) })),
        password,
        // Preserve header encryption (hidden file names) when the source
        // archive had it — the rebuilt archive must not lose it.
        encryptHeaders: hasEncryptedHeaders(archivePath),
        // Preserve the recovery record when the source archive had one.
        recoveryPercent: readRecoveryPercent(archivePath) ?? 0,
        level: options.level ?? 5,
      },
      progress,
      token,
      // Keep every extracted entry — exclusions only apply to files that
      // are newly added by copyIntoArchive callers.
      [],
    );

    let rebuiltSize = 0;
    try {
      rebuiltSize = fs.statSync(rebuiltPath).size;
    } catch {
      // stat is best-effort
    }
    logger.info({
      event: "rar5.rebuild.compressed",
      archivePath,
      rebuiltSize,
      topLevelEntries: topLevel.length,
    });

    // Atomic swap with a same-directory backup: a failure restores the
    // original archive instead of destroying it.
    const backupPath = `${archivePath}.rar5bak`;
    logger.info({ event: "rar5.rebuild.swap", archivePath, backupPath });
    fs.rmSync(backupPath, { force: true });
    fs.renameSync(archivePath, backupPath);
    try {
      fs.renameSync(rebuiltPath, archivePath);
      fs.rmSync(backupPath, { force: true });
      logger.info({ event: "rar5.rebuild.ok", archivePath });
    } catch (err) {
      try {
        fs.renameSync(backupPath, archivePath);
      } catch {
        logger.error(
          { event: "rar5.rebuild.restoreFailed", err },
          "Failed to restore original archive after rebuild failure",
        );
      }
      throw err;
    }
  } catch (err) {
    logger.error({ event: "rar5.rebuild.failed", archivePath, err });
    throw err;
  } finally {
    try {
      fs.rmSync(workRoot, { recursive: true, force: true });
      logger.debug({ event: "rar5.rebuild.cleanup", workRoot });
    } catch {
      // best-effort cleanup
    }
  }
}
