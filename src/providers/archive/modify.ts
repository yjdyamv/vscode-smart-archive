/**
 * Archive modify/preview/test operations — Smart Archive VSCode Extension
 *
 * @module providers/archive/modify
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import type { JS7zInstance } from "../../types";
import { JS7z, disposeJS7z, decompressLz4Frames, writeLargeVFS } from "../fileListing";
import { streamToVFS } from "../../engines/vfs-io";
import { getFullExt, isWrappedFormat } from "../../constants";
import { checkFileSize, validatePassword, sanitizeCliPath } from "../../utils/security";
import { t } from "../../i18n";
import { PREVIEW_TMP_DIR, pruneOldPreviews, registerPreviewCleanup } from "../tempFiles";
import { logger } from "../../utils/logger";

const MAX_PREVIEW_FILE_SIZE = 100 * 1024 * 1024; // 100 MB hard limit for preview
import { withWrappedArchive } from "./wrappedHelper";
import { brotliDecompress } from "../../engines/brotli-codec";
import {
  hasSystem7zForFormat,
  detectSystem7z,
  spawnCapture,
} from "../../engines/system7z";

export async function createFolderInArchive(
  archivePath: string,
  targetDir: string,
  folderName: string,
  password?: string,
): Promise<void> {
  const ext = getFullExt(archivePath);
  const normDir = targetDir.replace(/\\/g, "/").replace(/^\/+/, "");
  const folderPath = normDir ? `${normDir}/${folderName}` : folderName;

  logger.info({
    event: "createFolder.start",
    archivePath,
    targetDir,
    folderName,
    ext,
  });

  if (isWrappedFormat(ext)) {
    return createFolderInWrappedArchive(archivePath, targetDir, folderName, password);
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });

  try {
    const fsPath = streamToVFS(js7z, archivePath);
    const vfsFolder = `/${folderPath}`;
    let cur = "";
    for (const part of folderPath.split("/").filter(Boolean)) {
      cur += "/" + part;
      try {
        js7z.FS.mkdir(cur);
      } catch {
        logger.warn(
          { event: "createFolder.mkdir.failed" },
          "Failed to create directory in virtual FS",
        );
      }
    }
    const dotfile = `${vfsFolder}/.smartarchive`;
    js7z.FS.writeFile(dotfile, new Uint8Array(1));

    const parts = folderPath.split("/").filter(Boolean);
    const firstLevel = parts[0];
    const args = firstLevel
      ? ["a", fsPath, "-aot", `/${firstLevel}`]
      : ["a", fsPath, "-aot", dotfile];
    if (password) {
      validatePassword(password);
      args.splice(1, 0, `-p${password}`);
    }

    logger.debug({ event: "createFolder.7zAdd", args: args.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
      js7z.callMain(args);
    });

    const updated = js7z.FS.readFile(fsPath, { encoding: "binary" });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));
    logger.info({ event: "createFolder.ok", archivePath, folderPath });
  } finally {
    disposeJS7z(js7z);
  }
}

async function createFolderInWrappedArchive(
  archivePath: string,
  targetDir: string,
  folderName: string,
  password?: string,
): Promise<void> {
  const normDir = targetDir.replace(/\\/g, "/").replace(/^\/+/, "");
  const folderPath = normDir ? `${normDir}/${folderName}` : folderName;

  return withWrappedArchive(archivePath, password, async (js7z2) => {
    const vfsFolder = `/${folderPath}`;
    let cur = "";
    for (const part of folderPath.split("/").filter(Boolean)) {
      cur += "/" + part;
      try {
        js7z2.FS.mkdir(cur);
      } catch {
        logger.warn(
          { event: "createFolderWrapped.mkdir.failed" },
          "Failed to create directory in virtual FS",
        );
      }
    }
    const dotfile = `${vfsFolder}/.smartarchive`;
    js7z2.FS.writeFile(dotfile, new Uint8Array(1));

    const parts = folderPath.split("/").filter(Boolean);
    const firstLevel = parts[0];
    const aArgs = firstLevel
      ? ["a", "/inner.tar", "-aot", `/${firstLevel}`]
      : ["a", "/inner.tar", "-aot", dotfile];
    if (password) aArgs.splice(1, 0, `-p${password}`);
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a inner: ${c}`)));
      js7z2.callMain(aArgs);
    });
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

  let fileData: ArrayBuffer = new ArrayBuffer(0);

  // Fast path: use system 7z when available (no WASM overhead, no full-archive load).
  // Brotli and LZ4 are not supported by system 7z — fall through to WASM below.
  const useSystem7z = hasSystem7zForFormat(archiveExt, true);
  if (useSystem7z) {
    try {
      fileData = await extractOneWithSystem7z(
        archivePath,
        normalizedFile,
        archiveExt,
        password,
      );
    } catch (err) {
      logger.warn(
        { event: "previewFile.system7z.failed", err },
        "System 7z preview failed, falling back to WASM",
      );
    }
  }

  if (fileData.byteLength === 0) {
    const js7z = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      let archiveFsPath: string;

      // js7z WASM doesn't support LZ4. For .tar.lz4, decompress manually
      // and feed the inner tar to 7z.
      if (archiveExt === ".tar.lz4" || archiveExt === ".tlz4") {
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
        const innerTar = decompressLz4Frames(Buffer.from(buf));
        const tarName = path.basename(archivePath, archiveExt) + ".tar";
        archiveFsPath = `/${tarName}`;
        writeLargeVFS(js7z, archiveFsPath, innerTar);
      } else if (archiveExt === ".tar.br" || archiveExt === ".tbr") {
        // js7z WASM doesn't support Brotli. Decompress with brotli-wasm,
        // then feed the inner tar to 7z for extraction.
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
        const innerTar = brotliDecompress(new Uint8Array(buf));
        const tarName = path.basename(archivePath, archiveExt) + ".tar";
        archiveFsPath = `/${tarName}`;
        writeLargeVFS(js7z, archiveFsPath, innerTar);
      } else {
        archiveFsPath = streamToVFS(js7z, archivePath);
      }

      js7z.FS.mkdir("/_pv");

      const xArgs = ["x", archiveFsPath, "-o/_pv", "-y"];
      if (password) {
        validatePassword(password);
        xArgs.splice(1, 0, `-p${password}`);
      }
      const doSelective = !isWrappedFormat(archiveExt);
      if (doSelective) xArgs.push(sanitizeCliPath(normalizedFile));
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x: ${c}`)));
        js7z.callMain(xArgs);
      });

      let top = js7z.FS.readdir("/_pv").filter((e: string) => e !== "." && e !== "..");

      // If selective extraction produced nothing (e.g. ar archives like .deb),
      // retry extracting everything then locate the requested file.
      if (top.length === 0 && doSelective) {
        const allArgs = ["x", archiveFsPath, "-o/_pv", "-y"];
        if (password) allArgs.splice(1, 0, `-p${password}`);
        await new Promise<void>((resolve, reject) => {
          js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x: ${c}`)));
          js7z.callMain(allArgs);
        });
        top = js7z.FS.readdir("/_pv").filter((e: string) => e !== "." && e !== "..");
      }

      // Try reading the requested file directly
      const directPath = `/_pv/${normalizedFile}`;
      try {
        fileData = js7z.FS.readFile(directPath, { encoding: "binary" });
      } catch {
        logger.debug(
          { event: "previewFile.directRead.failed" },
          "Preview direct read failed, trying unwrap",
        );
        // File not found directly — try unwrapping inner tar archives
        const tarPatterns = [
          ".tar",
          ".tar.gz",
          ".tar.bz2",
          ".tar.xz",
          ".tar.zst",
          ".tar.lz",
          ".tar.lzma",
          ".tar.lz4",
          ".tar.br",
          ".tgz",
          ".tbz2",
          ".tbz",
          ".txz",
          ".tzst",
          ".tlz",
          ".tlz4",
          ".tbr",
        ];
        const tarEntries = top.filter((e) => tarPatterns.some((ext) => e.endsWith(ext)));
        let found = false;
        for (const tarEntry of tarEntries) {
          try {
            fileData = await unwrapArchives(js7z, `/_pv/${tarEntry}`, normalizedFile, password);
            found = true;
            break;
          } catch {
            logger.warn(
              { event: "previewFile.unwrap.failed" },
              "Preview unwrap failed for tar entry",
            );
            continue;
          }
        }
        if (!found) {
          logger.error(
            { event: "previewFile.notFound", path: normalizedFile },
            "Preview file not found in extracted content",
          );
          throw new Error(t("preview.notFound", normalizedFile));
        }
      }
    } finally {
      disposeJS7z(js7z);
    }
  }

  const buf = Buffer.from(fileData);
  if (buf.length > MAX_PREVIEW_FILE_SIZE) {
    throw new Error(t("preview.fileTooLarge", String(buf.length), String(MAX_PREVIEW_FILE_SIZE)));
  }
  fs.mkdirSync(PREVIEW_TMP_DIR, { recursive: true });
  const hash = crypto
    .createHash("sha256")
    .update(`${archivePath}|${normalizedFile}`)
    .digest("hex")
    .slice(0, 16);
  const ext = getFullExt(normalizedFile) || path.extname(normalizedFile);
  const tmpPath = path.join(PREVIEW_TMP_DIR, `${hash}${ext}`);
  if (!fs.existsSync(tmpPath)) {
    pruneOldPreviews();
    fs.writeFileSync(tmpPath, buf);
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
    try { cleanupDisposable.dispose(); } catch {}
  }, 600_000);
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
  const sz = detectSystem7z();
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

    // Locate the extracted file — try exact expected path first, then walk
    const expectedPath = path.join(tmpDir, ...normalizedFile.split("/"));
    let filePath: string | null = null;
    if (fs.existsSync(expectedPath)) {
      const st = fs.statSync(expectedPath);
      if (st.isFile()) filePath = expectedPath;
    }
    if (!filePath) {
      // Check inside single-subdirectory (e.g. _inner for wrapped formats)
      const topDirs = fs.readdirSync(tmpDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      for (const d of topDirs) {
        const candidate = path.join(tmpDir, d.name, ...normalizedFile.split("/"));
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

    return new Uint8Array(fs.readFileSync(filePath)).buffer;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function unwrapArchives(
  js7z: JS7zInstance,
  archiveVfsPath: string,
  target: string,
  password?: string,
): Promise<ArrayBuffer> {
  logger.info({ event: "preview.unwrap", archiveVfsPath, target });
  const archiveName = archiveVfsPath.replace(/^\/_pv\//, "");
  const rawData = js7z.FS.readFile(archiveVfsPath, { encoding: "binary" });
  const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z2.FS.writeFile(`/${archiveName}`, new Uint8Array(rawData));
    js7z2.FS.mkdir("/_pv2");
    const args = ["x", `/${archiveName}`, "-o/_pv2", "-y", sanitizeCliPath(target)];
    if (password) {
      validatePassword(password);
      args.splice(1, 0, `-p${password}`);
    }
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x inner: ${c}`)));
      js7z2.callMain(args);
    });

    // Try direct path first, then fall back to reading the first non-dir entry
    const vfsPath = `/_pv2/${target}`;
    try {
      return js7z2.FS.readFile(vfsPath, { encoding: "binary" });
    } catch {
      logger.debug(
        { event: "previewFile.unwrapDirectRead.failed" },
        "Direct read failed in unwrap, checking flattened entries",
      );
      // 7z may have flattened the path — look for the base name.
      // Skip .tar entries (intermediate artifacts from wrapped archives).
      const top2 = js7z2.FS.readdir("/_pv2").filter((e: string) => e !== "." && e !== "..");
      for (const entry of top2) {
        if (entry.endsWith(".tar")) continue;
        const ep = `/_pv2/${entry}`;
        try {
          const st = js7z2.FS.stat(ep);
          if (!js7z2.FS.isDir(st.mode)) {
            return js7z2.FS.readFile(ep, { encoding: "binary" });
          }
        } catch {
          logger.debug({ event: "previewFile.stat.failed" }, "Stat failed for entry, skipping");
          continue;
        }
      }
      throw new Error(t("preview.notFoundInner", target));
    }
  } finally {
    disposeJS7z(js7z2);
  }
}

export async function testArchive(archivePath: string, password?: string): Promise<string> {
  logger.info({ event: "testArchive.start", archivePath });
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  let stdout = "";
  const js7z = await JS7z({
    print: (text: string) => {
      stdout += text + "\n";
    },
    printErr: () => {},
  });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    const tArgs = ["t", `/${archiveName}`];
    if (password) {
      validatePassword(password);
      tArgs.splice(1, 0, `-p${password}`);
    }
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) =>
        c === 0 ? resolve() : reject(new Error(`7z t: ${c}\n${stdout}`));
      js7z.callMain(tArgs);
    });
    const ok = stdout.includes("Everything is Ok");
    const result = ok ? t("test.passed") : t("test.warnings") + stdout.slice(-200);
    logger.info({ event: "testArchive.ok", archivePath, passed: ok });
    return result;
  } finally {
    disposeJS7z(js7z);
  }
}

export async function renameInArchive(
  archivePath: string,
  oldPath: string,
  newPath: string,
  password?: string,
): Promise<void> {
  logger.info({ event: "rename.start", archivePath, oldPath, newPath });

  const ext = getFullExt(archivePath);
  if (isWrappedFormat(ext)) {
    return renameInWrappedArchive(archivePath, oldPath, newPath, password);
  }

  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(archivePath));
  checkFileSize(stat.size);
  const oldNorm = oldPath.replace(/\\/g, "/");
  const newNorm = newPath.replace(/\\/g, "/");

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const fsPath = streamToVFS(js7z, archivePath);
    const rnArgs = ["rn", fsPath, sanitizeCliPath(oldNorm), sanitizeCliPath(newNorm)];
    if (password) { validatePassword(password); rnArgs.splice(1, 0, `-p${password}`); }
    logger.debug({ event: "rename.7zArgs", args: rnArgs.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z rn: ${c}`)));
      js7z.callMain(rnArgs);
    });

    const updated = js7z.FS.readFile(fsPath, { encoding: "binary" });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), new Uint8Array(updated));
    logger.info({ event: "rename.ok", archivePath, oldPath, newPath });
  } finally {
    disposeJS7z(js7z);
  }
}

async function renameInWrappedArchive(
  archivePath: string,
  oldPath: string,
  newPath: string,
  password?: string,
): Promise<void> {
  logger.info({ event: "renameInWrapped.start", archivePath, oldPath, newPath });
  const oldNorm = oldPath.replace(/\\/g, "/");
  const newNorm = newPath.replace(/\\/g, "/");
  await withWrappedArchive(archivePath, password, async (js7z2) => {
    const rnArgs = ["rn", "/inner.tar", sanitizeCliPath(oldNorm), sanitizeCliPath(newNorm)];
    if (password) { validatePassword(password); rnArgs.splice(1, 0, `-p${password}`); }
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z rn inner: ${c}`)));
      js7z2.callMain(rnArgs);
    });
  });
  logger.info({ event: "renameInWrapped.ok", archivePath, oldPath, newPath });
}
