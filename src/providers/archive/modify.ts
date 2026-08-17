/**
 * Archive modify/preview/test operations — Smart Archiver VSCode Extension
 *
 * Host-side dispatchers: the WASM mutations run in the worker thread
 * (engines/modify-core). Preview keeps its system-7z fast path (child
 * process) on the host; the WASM fallback writes to a host-managed
 * temp file via the worker.
 *
 * @module providers/archive/modify
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import {
  CACHE_HASH_ALGO,
  getFullExt,
  isWrappedFormat,
  MAX_PREVIEW_FILE_SIZE,
} from "../../constants";
import { t } from "../../i18n";
import { PreviewTooLargeError } from "../../utils/errors";
import { getPreviewTmpDir, pruneOldPreviews, registerPreviewCleanup } from "../tempFiles";
import {
  getPreviewCacheConfig,
  previewCacheHit,
  previewCachePath,
  storePreviewCache,
} from "../previewCache";
import { secureRmDir, secureUnlink } from "../../utils/fs";

/** Delay before disposing the preview tab cleanup subscription (10 min) */
const PREVIEW_CLEANUP_DELAY_MS = 600_000;
import { logger } from "../../utils/logger";
import {
  addToArchiveSystem7z,
  hasSystem7zForFormat,
  renameInArchiveSystem7z,
  spawnCapture,
  system7zForExt,
  testArchiveWithSystem7z,
} from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";
import { selectEngine } from "../../engines/select-engine";
import { rebuildRarArchive, archiveJoin } from "./rar5-modify";

export async function createFolderInArchive(
  archivePath: string,
  targetDir: string,
  folderName: string,
  password?: string,
): Promise<void> {
  logger.info({
    event: "createFolder.start",
    archivePath,
    targetDir,
    folderName,
    ext: getFullExt(archivePath),
  });
  const { engine } = selectEngine({
    op: "createFolder",
    ext: getFullExt(archivePath),
    password,
  });

  // 7-Zip cannot create folders inside RAR archives — rebuild instead.
  if (engine === "rarRebuild") {
    logger.info({ event: "createFolder.rar5.rebuild", archivePath, targetDir, folderName });
    const newDir = targetDir ? `${targetDir.replace(/\\/g, "/")}/${folderName}` : folderName;
    await rebuildRarArchive({
      archivePath,
      password,
      mutate: (root) => {
        fs.mkdirSync(archiveJoin(root, newDir), { recursive: true });
      },
    });
    return;
  }

  if (engine === "system7z") {
    // 7-Zip has no mkdir command; add a temp folder carrying the same
    // .smartarchive marker the WASM path uses so the archive stores it.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saf_"));
    try {
      const folderAbs = path.join(tmpRoot, folderName);
      fs.mkdirSync(folderAbs, { recursive: true });
      fs.writeFileSync(path.join(folderAbs, ".smartarchive"), " ");
      await addToArchiveSystem7z(archivePath, [folderAbs], targetDir, undefined, password);
      logger.info({ event: "createFolder.system7z.ok", archivePath, targetDir, folderName });
    } finally {
      try {
        secureRmDir(tmpRoot);
      } catch {}
    }
    return;
  }

  // Wrapped formats (and no system 7z) still rebuild the inner tar in WASM.
  await runArchiveOp("modify", {
    action: "createFolder",
    archivePath,
    targetDir,
    folderName,
    password,
  });
}

export async function previewFileFromArchive(
  archivePath: string,
  filePath: string,
  password?: string,
): Promise<void> {
  const archiveExt = getFullExt(archivePath);
  // Stat once up front: the size feeds the log and both mtimeMs and size
  // key the preview cache, so a modified archive gets a fresh extraction
  // instead of a stale cached file.
  const archiveStat = fs.statSync(archivePath);
  logger.info({
    event: "previewFile.start",
    archivePath,
    file: filePath,
    sizeBytes: archiveStat.size,
  });

  const normalizedFile = filePath.replace(/\\/g, "/");
  const ext = getFullExt(normalizedFile) || path.extname(normalizedFile);

  // Encrypted archives never persist: the decrypted bytes would leak to
  // disk indefinitely. They keep the session temp dir (deleted when the
  // preview document closes). Unencrypted previews go to the persistent
  // preview cache — closing the tab or VS Code does not lose them.
  const encrypted = !!password;
  // Extraction staging is always the per-session temp dir (deleted on tab
  // close / session end). Small unencrypted previews are promoted into the
  // persistent cache after extraction; large files never enter the cache —
  // re-previewing them costs a re-extraction, not 30 days of disk. Encrypted
  // archives never persist (decrypted bytes would leak to disk indefinitely).
  const cacheFile = encrypted
    ? null
    : previewCachePath(archivePath, archiveStat.mtimeMs, archiveStat.size, normalizedFile, ext);
  const hash = crypto
    .createHash(CACHE_HASH_ALGO)
    .update(`${archivePath}|${archiveStat.mtimeMs}|${archiveStat.size}|${normalizedFile}`)
    .digest("hex")
    .slice(0, 16);
  const tmpPath = path.join(getPreviewTmpDir(), `${hash}${ext}`);

  // Cache hit: the archive (path + mtime + size) and the entry are
  // unchanged — serve the previously extracted file without touching
  // either engine. A modified archive produces a different key, so the
  // old cache file just becomes an orphan and is pruned later. The hit
  // check lstat-verifies a regular file: the key is derived from public
  // inputs, so a planted symlink/FIFO must not be opened in the editor.
  if (cacheFile && previewCacheHit(cacheFile)) {
    // Refresh mtime so the sweep's LRU is an idle-TTL: only entries that
    // are actually revisited keep occupying disk.
    try {
      fs.utimesSync(cacheFile, new Date(), new Date());
    } catch {
      // Best effort.
    }
    logger.debug({ event: "previewFile.cacheHit", archivePath, filePath, tmpPath: cacheFile });
    const uri = vscode.Uri.file(cacheFile);
    await vscode.commands.executeCommand("vscode.open", uri, {
      preview: true,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
    logger.info({
      event: "previewFile.ok",
      archivePath,
      filePath,
      tmpPath: cacheFile,
      cached: true,
    });
    return;
  }

  let extracted = false;

  // Fast path: use system 7z when available (no WASM overhead, no full-archive
  // load). Brotli and LZ4 are not supported by system 7z — falls through to
  // the worker below.
  const { engine: previewEngine } = selectEngine({ op: "preview", ext: archiveExt, password });
  if (previewEngine === "system7z") {
    try {
      const fileData = await extractOneWithSystem7z(
        archivePath,
        normalizedFile,
        archiveExt,
        password,
      );
      const buf = Buffer.from(fileData);
      if (buf.length > MAX_PREVIEW_FILE_SIZE) {
        throw new PreviewTooLargeError(
          t("preview.fileTooLarge", String(buf.length), String(MAX_PREVIEW_FILE_SIZE)),
          buf.length,
          MAX_PREVIEW_FILE_SIZE,
        );
      }
      if (!fs.existsSync(tmpPath)) {
        pruneOldPreviews();
        fs.writeFileSync(tmpPath, buf, { flag: "wx" });
      }
      extracted = true;
    } catch (err) {
      // The WASM fallback hits the identical size limit after another full
      // decompression — rethrow instead of paying for it twice.
      if (err instanceof PreviewTooLargeError) throw err;
      logger.warn(
        { event: "previewFile.system7z.failed", err },
        "System 7z preview failed, falling back to WASM",
      );
    }
  }

  if (!extracted) {
    // WASM path in the worker — it writes the extracted bytes to tmpPath.
    await runArchiveOp("modify", {
      action: "preview",
      archivePath,
      filePath: normalizedFile,
      password,
      outputPath: tmpPath,
    });
  }

  // Promote into the persistent cache: unencrypted and within the disk
  // budget. The cache copy survives tab close (the cache sweeps it by
  // idle-TTL/orphan/count); anything else keeps the temp staging, which
  // dies with the tab. A failed promote (race, IO) degrades to temp — the
  // preview still works. The origin (archive path + stat) is recorded so
  // deleting/moving/modifying the archive reclaims the entry as an orphan.
  let openPath = tmpPath;
  if (cacheFile) {
    try {
      const st = fs.statSync(tmpPath);
      if (st.size <= getPreviewCacheConfig().maxCacheableBytes) {
        await storePreviewCache(cacheFile, fs.readFileSync(tmpPath), {
          archivePath,
          mtimeMs: archiveStat.mtimeMs,
          size: archiveStat.size,
        });
        openPath = cacheFile;
        secureUnlink(tmpPath);
      }
    } catch (err) {
      logger.warn({ event: "previewFile.promote.failed", err }, "Preview cache promote failed");
    }
  }

  const uri = vscode.Uri.file(openPath);
  await vscode.commands.executeCommand("vscode.open", uri, {
    preview: true,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.Beside,
  });
  // Temp staging dies with the tab (encrypted, or too large to cache);
  // promoted cache files survive tab close.
  if (openPath === tmpPath) {
    const cleanupDisposable = registerPreviewCleanup(tmpPath, uri);
    setTimeout(() => {
      try {
        cleanupDisposable.dispose();
      } catch {
        logger.warn({ event: "preview.cleanup.failed" }, "Failed to dispose preview cleanup");
      }
    }, PREVIEW_CLEANUP_DELAY_MS);
  }
  logger.info({ event: "previewFile.ok", archivePath, filePath, tmpPath: openPath });
}

/**
 * System 7z fast path: extract a single file from an archive using the
 * locally-installed 7-Zip binary. Avoids WASM init + full archive VFS copy.
 *
 * Non-wrapped formats (7z, zip, tar): one-step selective extraction.
 * Wrapped formats (tar.gz, tar.bz2, tar.xz, tar.zst): two-step.
 */
async function extractOneWithSystem7z(
  archivePath: string,
  normalizedFile: string,
  archiveExt: string,
  password?: string,
): Promise<ArrayBuffer> {
  const sz = system7zForExt(archiveExt);
  if (!sz) throw new Error("System 7z not found");

  const wrapped = isWrappedFormat(archiveExt);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sap_"));

  try {
    if (!wrapped) {
      // One step: 7z x archive -o<tmp> -aoa -y -- file
      const args: string[] = ["x", archivePath, `-o${tmpDir}`, "-aoa", "-y"];
      args.push("--", normalizedFile);
      // No -p switch: 7z prompts for the archive password; spawnCapture feeds
      // it via stdin (never argv).
      const { code } = await spawnCapture(sz, args, { password });
      if (code !== 0) throw new Error(`7z x non-wrapped exit ${code}`);
    } else {
      // Two step: first extract outer layer, then inner tar. 7-Zip
      // auto-unpacks the inner tar for some wraps (tar.xz/tar.bz2/tar.gz
      // produce the file tree directly in tmpOuter, with no intermediate
      // .tar kept) — in that case the second step is skipped and the
      // locate logic below finds the file inside the tree.
      const tmpOuter = path.join(tmpDir, "_outer");
      fs.mkdirSync(tmpOuter);
      const args1: string[] = ["x", archivePath, `-o${tmpOuter}`, "-y"];
      const r1 = await spawnCapture(sz, args1, { password });
      if (r1.code !== 0) throw new Error(`7z x outer exit ${r1.code}`);

      const entries = fs.readdirSync(tmpOuter);
      const innerTar = entries.find((e) => e.endsWith(".tar"));
      if (innerTar) {
        const innerPath = path.join(tmpOuter, innerTar);
        const tmpInner = path.join(tmpDir, "_inner");
        fs.mkdirSync(tmpInner);
        const args2: string[] = [
          "x",
          innerPath,
          `-o${tmpInner}`,
          "-aoa",
          "-y",
          "--",
          normalizedFile,
        ];
        const r2 = await spawnCapture(sz, args2);
        if (r2.code !== 0) throw new Error(`7z x inner exit ${r2.code}`);
      }
    }

    // Locate the extracted file — try exact expected path first, then walk.
    // Reject path traversal components before joining with tmpDir.
    const pathSegments = normalizedFile.split("/");
    for (const seg of pathSegments) {
      if (seg === ".." || seg === ".") {
        throw new Error(t("security.pathTraversal"));
      }
    }
    const expectedPath = path.join(tmpDir, ...pathSegments);
    let filePath: string | null = null;
    if (fs.existsSync(expectedPath)) {
      const st = fs.statSync(expectedPath);
      if (st.isFile()) filePath = expectedPath;
    }
    if (!filePath) {
      // Check inside single-subdirectory (e.g. _inner for wrapped formats)
      const topDirs = fs
        .readdirSync(tmpDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      for (const d of topDirs) {
        const candidate = path.join(tmpDir, d.name, ...pathSegments);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          filePath = candidate;
          break;
        }
      }
    }
    if (!filePath) {
      // Last resort: recursive walk
      const findFile = (dir: string): string | null => {
        const ents = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of ents) {
          const full = path.join(dir, e.name);
          if (e.name.endsWith(".tar")) continue; // skip inner tar artifacts
          if (e.isFile()) return full;
          if (e.isDirectory()) {
            const found = findFile(full);
            if (found) return found;
          }
        }
        return null;
      };
      filePath = findFile(tmpDir);
    }
    if (!filePath) throw new Error("Extracted file not found");

    // The lookups above use statSync, which follows symlinks: a crafted archive
    // whose entry is a symlink to an absolute host path (e.g. ~/.ssh/id_rsa)
    // would otherwise be read here and exposed via preview/copy. Refuse anything
    // whose real path escapes the temp extraction dir.
    const realTmp = fs.realpathSync(tmpDir);
    const realBefore = fs.realpathSync(filePath);
    if (realBefore !== realTmp && !realBefore.startsWith(realTmp + path.sep)) {
      throw new Error(t("security.pathEscape", realBefore, realTmp));
    }

    const buf = fs.readFileSync(filePath);
    // Re-verify realpath after read to catch TOCTOU symlink swap.
    const realAfter = fs.realpathSync(filePath);
    if (realAfter !== realBefore) {
      throw new Error(t("security.pathEscape", realAfter, realTmp));
    }

    return new Uint8Array(buf).buffer;
  } finally {
    try {
      secureRmDir(tmpDir);
    } catch {
      // best effort
    }
  }
}

export async function testArchive(archivePath: string, password?: string): Promise<string> {
  logger.info({ event: "testArchive.start", archivePath });
  const ext = getFullExt(archivePath);
  if (hasSystem7zForFormat(ext, true)) {
    logger.info({ event: "testArchive.system7z", archivePath, ext });
    return testArchiveWithSystem7z(archivePath, password);
  }
  logger.info({ event: "testArchive.worker", archivePath, ext });
  return runArchiveOp<string>("modify", { action: "test", archivePath, password });
}

export async function renameInArchive(
  archivePath: string,
  oldPath: string,
  newPath: string,
  password?: string,
): Promise<void> {
  logger.info({ event: "rename.start", archivePath, oldPath, newPath });

  const ext = getFullExt(archivePath);
  const { engine } = selectEngine({ op: "rename", ext, password });

  // 7-Zip cannot rename entries inside RAR archives — rebuild instead.
  if (engine === "rarRebuild") {
    logger.info({ event: "rename.rar5.rebuild", archivePath, oldPath, newPath });
    await rebuildRarArchive({
      archivePath,
      password,
      mutate: (root) => {
        const src = archiveJoin(root, oldPath);
        const dst = archiveJoin(root, newPath);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
      },
    });
    return;
  }

  if (engine === "system7z") {
    logger.info({ event: "rename.system7z", archivePath, ext });
    await renameInArchiveSystem7z(archivePath, oldPath, newPath, password);
    return;
  }

  logger.info({ event: "rename.worker", archivePath, ext });
  await runArchiveOp("modify", {
    action: "rename",
    archivePath,
    oldPath,
    newPath,
    password,
  });
}
