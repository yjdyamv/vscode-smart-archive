/**
 * Archive modify/preview/test operations — Smart Archive VSCode Extension
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
import { getFullExt, isWrappedFormat, MAX_PREVIEW_FILE_SIZE } from "../../constants";
import { isRarExt } from "../../utils/rar";
import { checkFileSize, validatePassword } from "../../utils/security";
import { t } from "../../i18n";
import { getPreviewTmpDir, pruneOldPreviews, registerPreviewCleanup } from "../tempFiles";

/** Delay before disposing the preview tab cleanup subscription (10 min) */
const PREVIEW_CLEANUP_DELAY_MS = 600_000;
import { logger } from "../../utils/logger";
import {
  hasSystem7zForFormat,
  system7zForExt,
  spawnCapture,
  renameInArchiveSystem7z,
} from "../../engines/system7z";
import { runArchiveOp } from "../../engines/worker/runner";
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

  // 7-Zip cannot create folders inside RAR archives — rebuild instead.
  if (isRarExt(getFullExt(archivePath))) {
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

  // No system-7z fast path for folder creation — WASM in the worker.
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
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  logger.info({
    event: "previewFile.start",
    archivePath,
    file: filePath,
    sizeBytes: stat.size,
  });

  const normalizedFile = filePath.replace(/\\/g, "/");

  const previewDir = getPreviewTmpDir();
  const hash = crypto
    .createHash("sha256")
    .update(`${archivePath}|${normalizedFile}`)
    .digest("hex")
    .slice(0, 16);
  const ext = getFullExt(normalizedFile) || path.extname(normalizedFile);
  const tmpPath = path.join(previewDir, `${hash}${ext}`);

  let extracted = false;

  // Fast path: use system 7z when available (no WASM overhead, no full-archive
  // load). Brotli and LZ4 are not supported by system 7z — falls through to
  // the worker below.
  if (hasSystem7zForFormat(archiveExt, true)) {
    try {
      const fileData = await extractOneWithSystem7z(
        archivePath,
        normalizedFile,
        archiveExt,
        password,
      );
      const buf = Buffer.from(fileData);
      if (buf.length > MAX_PREVIEW_FILE_SIZE) {
        throw new Error(
          t("preview.fileTooLarge", String(buf.length), String(MAX_PREVIEW_FILE_SIZE)),
        );
      }
      if (!fs.existsSync(tmpPath)) {
        pruneOldPreviews();
        fs.writeFileSync(tmpPath, buf, { flag: "wx" });
      }
      extracted = true;
    } catch (err) {
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

  const uri = vscode.Uri.file(tmpPath);
  await vscode.commands.executeCommand("vscode.open", uri, {
    preview: true,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.Beside,
  });
  // Best-effort cleanup when tab closes (works for text files; binary
  // files are handled by pruneOldPreviews which caps at 100 files).
  const cleanupDisposable = registerPreviewCleanup(tmpPath, uri);
  setTimeout(() => {
    try {
      cleanupDisposable.dispose();
    } catch {
      logger.warn({ event: "preview.cleanup.failed" }, "Failed to dispose preview cleanup");
    }
  }, PREVIEW_CLEANUP_DELAY_MS);
  logger.info({ event: "previewFile.ok", archivePath, filePath, tmpPath });
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
      if (password) {
        validatePassword(password);
        args.splice(1, 0, `-p${password}`);
      }
      args.push("--", normalizedFile);
      const { code } = await spawnCapture(sz, args);
      if (code !== 0) throw new Error(`7z x non-wrapped exit ${code}`);
    } else {
      // Two step: first extract outer layer, then inner tar
      const tmpOuter = path.join(tmpDir, "_outer");
      fs.mkdirSync(tmpOuter);
      const args1: string[] = ["x", archivePath, `-o${tmpOuter}`, "-y"];
      if (password) {
        validatePassword(password);
        args1.splice(1, 0, `-p${password}`);
      }
      const r1 = await spawnCapture(sz, args1);
      if (r1.code !== 0) throw new Error(`7z x outer exit ${r1.code}`);

      // Find the inner tar
      const entries = fs.readdirSync(tmpOuter);
      const innerTar = entries.find((e) => e.endsWith(".tar"));
      if (!innerTar) throw new Error("No inner tar found in wrapped archive");
      const innerPath = path.join(tmpOuter, innerTar);

      const tmpInner = path.join(tmpDir, "_inner");
      fs.mkdirSync(tmpInner);
      const args2: string[] = ["x", innerPath, `-o${tmpInner}`, "-aoa", "-y", "--", normalizedFile];
      const r2 = await spawnCapture(sz, args2);
      if (r2.code !== 0) throw new Error(`7z x inner exit ${r2.code}`);
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export async function testArchive(archivePath: string, password?: string): Promise<string> {
  logger.info({ event: "testArchive.start", archivePath });
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
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

  // 7-Zip cannot rename entries inside RAR archives — rebuild instead.
  if (isRarExt(ext)) {
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

  // Wrapped formats always mutate via WASM (worker).
  if (!isWrappedFormat(ext) && hasSystem7zForFormat(ext) && !password) {
    // System 7z passes passwords via -p<password> on the command line,
    // visible in process listings. For encrypted archives, fall back to
    // WASM to avoid CLI password leakage.
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
