/**
 * Rebuild-based RAR archive modification — Smart Archive VSCode Extension
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

    await compressWithRar5(
      {
        format: RAR5_FORMAT,
        outputPath: rebuiltPath,
        targets: topLevel.map((n) => ({ fsPath: path.join(extractRoot, n) })),
        password,
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
