/**
 * Archive modify core — Smart Archive VSCode Extension
 *
 * Vscode-free WASM mutations of existing archives (add / delete / rename /
 * createFolder / preview / test), runs inside the worker thread.
 * Host dispatchers: providers/archive/{add,delete,modify}.ts.
 *
 * @module engines/modify-core
 */

import * as fs from "fs";
import * as path from "path";
import type { JS7zInstance } from "../types";
import { streamToVFS } from "./vfs-io";
import { writeLargeVFS } from "./fileListing-core";
import { getFullExt, isWrappedFormat, getWrapExtension } from "../constants";
import { checkFileSize, validatePassword, sanitizeCliPath } from "../utils/security";
import { getBaseName } from "../utils/path";
import { logger } from "../utils/logger-core";
import { t } from "../i18n";
import { prepareExclusions, isPathExcluded, type ExclusionSet } from "../utils/exclude";
import { zstdCompress } from "./zstd-codec";
import { brotliCompress, brotliDecompress } from "./brotli-codec";
import { lz4Compress, lz4Decompress } from "./lz4-codec";
import { snappyCompress, snappyDecompress } from "./snappy-codec";
import { decompressLz4Frames } from "./lz4-codec";
import { JS7z } from "./js7z-factory";
import { disposeJS7z } from "./js7z-lifecycle";
import { CancelledError } from "../utils/cancellation";
import type { TokenLike } from "../utils/cancellation";

/** Injected config (locale-independent): default compression level. */
let _compressionLevel = 5;

export function setModifyConfig(config: { compressionLevel?: number }): void {
  if (typeof config.compressionLevel === "number") _compressionLevel = config.compressionLevel;
}

// ── Wrapped archive helper ──

/**
 * Run a mutation on a wrapped archive (tar.gz, tar.xz, etc.).
 *
 * 1. Extract outer compression layer
 * 2. Run `innerOp` on a fresh JS7z instance loaded with the inner .tar
 * 3. Recompress and write back
 */
export async function withWrappedArchiveCore(
  archivePath: string,
  password: string | undefined,
  innerOp: (js7z2: JS7zInstance) => Promise<void>,
  token?: TokenLike,
): Promise<void> {
  const ext = getFullExt(archivePath);
  const data = fs.readFileSync(archivePath);
  const archiveName = path.basename(archivePath);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const tmpDir = "/_wrap1";
    js7z.FS.mkdir(tmpDir);
    let innerTarName: string;

    // js7z WASM doesn't support Brotli or LZ4. Decompress the outer
    // layer manually and place the inner .tar directly into VFS.
    if (ext === ".tar.br" || ext === ".tbr") {
      const innerTar = brotliDecompress(new Uint8Array(data));
      innerTarName = path.basename(archivePath, ext) + ".tar";
      js7z.FS.writeFile(`/${innerTarName}`, innerTar);
      js7z.FS.writeFile(`${tmpDir}/${innerTarName}`, innerTar);
    } else if (ext === ".tar.lz4" || ext === ".tlz4") {
      const innerTar = await lz4Decompress(new Uint8Array(data));
      innerTarName = path.basename(archivePath, ext) + ".tar";
      js7z.FS.writeFile(`/${innerTarName}`, innerTar);
      js7z.FS.writeFile(`${tmpDir}/${innerTarName}`, innerTar);
    } else if (ext === ".tar.sz" || ext === ".tsz") {
      const innerTar = await snappyDecompress(new Uint8Array(data));
      innerTarName = path.basename(archivePath, ext) + ".tar";
      js7z.FS.writeFile(`/${innerTarName}`, innerTar);
      js7z.FS.writeFile(`${tmpDir}/${innerTarName}`, innerTar);
    } else {
      js7z.FS.writeFile(`/${archiveName}`, data);

      const xArgs = ["x", `/${archiveName}`, `-o${tmpDir}`, "-y"];
      if (password) {
        validatePassword(password);
        xArgs.splice(1, 0, `-p${password}`);
      }
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x: ${c}`)));
        js7z.callMain(xArgs);
      });

      const top = js7z.FS.readdir(tmpDir).filter((e: string) => e !== "." && e !== "..");
      const found = top.find((e: string) => e.endsWith(".tar"));
      if (!found) throw new Error(t("archive.noInnerTar"));
      innerTarName = found;
    }

    const innerData = js7z.FS.readFile(`${tmpDir}/${innerTarName}`, { encoding: "binary" });
    const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      js7z2.FS.writeFile("/inner.tar", new Uint8Array(innerData));

      await innerOp(js7z2);

      const modifiedTar = js7z2.FS.readFile("/inner.tar", { encoding: "binary" });
      const wrapExt = getWrapExtension(ext);

      let compressedData: Uint8Array;
      if (wrapExt === "zst") {
        compressedData = await zstdCompress(new Uint8Array(modifiedTar), _compressionLevel);
      } else if (wrapExt === "lz4") {
        compressedData = await lz4Compress(new Uint8Array(modifiedTar));
      } else if (wrapExt === "br") {
        compressedData = brotliCompress(new Uint8Array(modifiedTar), _compressionLevel);
      } else if (wrapExt === "sz") {
        compressedData = await snappyCompress(new Uint8Array(modifiedTar));
      } else {
        // Use a fresh instance for recompression — reusing js7z2 after
        // callMain (7z d/7z rn) causes the second callMain (7z a) to hang.
        const js7z3 = await JS7z({ print: () => {}, printErr: () => {} });
        try {
          js7z3.FS.writeFile("/_re.tar", new Uint8Array(modifiedTar));
          const compOut = `/_re.${wrapExt}`;
          const compArgs = ["a", compOut, "/_re.tar"];
          if (password) {
            validatePassword(password);
            compArgs.splice(1, 0, `-p${password}`);
          }
          await new Promise<void>((resolve, reject) => {
            js7z3.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
            js7z3.callMain(compArgs);
          });
          compressedData = new Uint8Array(js7z3.FS.readFile(compOut, { encoding: "binary" }));
        } finally {
          disposeJS7z(js7z3);
        }
      }

      if (token?.isCancellationRequested) throw new CancelledError();
      fs.writeFileSync(archivePath, Buffer.from(compressedData));
    } finally {
      disposeJS7z(js7z2);
    }
  } finally {
    disposeJS7z(js7z);
  }
}

// ── Add ──

function copyLocalToFSWithPrefix(
  js7z: JS7zInstance,
  localPaths: string[],
  targetDir: string,
  exclusions?: ExclusionSet,
  token?: TokenLike,
): { vfsPaths: string[]; vfsDir: string | null } {
  const normDir = targetDir.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normDir ? normDir.split("/").filter(Boolean) : [];
  const firstLevel = parts[0] || null;
  const vfsBase = normDir ? `/${normDir}` : "";
  const vfsDir = firstLevel ? `/${firstLevel}` : null;

  if (normDir) {
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      try {
        js7z.FS.mkdir(cur);
      } catch {
        logger.warn(
          { event: "addToArchive.mkdir.failed" },
          "Failed to create directory in virtual FS",
        );
      }
    }
  }

  const vfsPaths: string[] = [];

  for (const localPath of localPaths) {
    if (token?.isCancellationRequested) throw new CancelledError();
    const name = getBaseName(localPath);
    if (exclusions && isPathExcluded(name, exclusions)) {
      logger.info({ event: "addToArchive.skipExcluded", path: localPath, name });
      continue;
    }
    const vfsTarget = vfsBase ? `${vfsBase}/${name}` : `/${name}`;
    const stat = fs.statSync(localPath);

    if (stat.isDirectory()) {
      js7z.FS.mkdir(vfsTarget);
      copyDirToFSRecursive(js7z, localPath, vfsTarget, exclusions, token);
    } else {
      streamToVFS(js7z, localPath, vfsTarget);
    }
    vfsPaths.push(vfsTarget);
  }
  return { vfsPaths, vfsDir };
}

function copyDirToFSRecursive(
  js7z: JS7zInstance,
  localDir: string,
  vfsDir: string,
  exclusions?: ExclusionSet,
  token?: TokenLike,
): void {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    if (token?.isCancellationRequested) throw new CancelledError();
    if (exclusions && isPathExcluded(entry.name, exclusions)) {
      logger.info({
        event: "addToArchive.skipExcludedRecursive",
        name: entry.name,
        dir: localDir,
      });
      continue;
    }
    const localEntry = path.join(localDir, entry.name);
    const vfsEntry = `${vfsDir}/${entry.name}`;
    if (entry.isDirectory()) {
      js7z.FS.mkdir(vfsEntry);
      copyDirToFSRecursive(js7z, localEntry, vfsEntry, exclusions, token);
    } else {
      streamToVFS(js7z, localEntry, vfsEntry);
    }
  }
}

export async function addToArchiveCore(
  archivePath: string,
  localPaths: string[],
  targetDir: string,
  password?: string,
  excludePatterns?: string[],
  token?: TokenLike,
): Promise<void> {
  const ext = getFullExt(archivePath);
  const exclusions = excludePatterns?.length ? prepareExclusions(excludePatterns) : undefined;

  if (isWrappedFormat(ext)) {
    logger.info({ event: "addToArchive.wrapped", archivePath, ext });
    return withWrappedArchiveCore(
      archivePath,
      password,
      async (js7z2) => {
        const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(
          js7z2,
          localPaths,
          targetDir,
          exclusions,
          token,
        );

        const aArgs = vfsDir
          ? ["a", "/inner.tar", "-aot", vfsDir]
          : ["a", "/inner.tar", "-aot", ...vfsPaths];
        if (password) {
          validatePassword(password);
          aArgs.splice(1, 0, `-p${password}`);
        }

        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (c: number) =>
            c === 0 ? resolve() : reject(new Error(`7z a inner: ${c}`));
          js7z2.callMain(aArgs);
        });
      },
      token,
    );
  }

  checkFileSize(fs.statSync(archivePath).size);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const archiveFsPath = streamToVFS(js7z, archivePath);

    const { vfsPaths, vfsDir } = copyLocalToFSWithPrefix(
      js7z,
      localPaths,
      targetDir,
      exclusions,
      token,
    );

    const args = vfsDir
      ? ["a", archiveFsPath, "-aot", vfsDir]
      : ["a", archiveFsPath, "-aot", ...vfsPaths];
    if (password) {
      validatePassword(password);
      args.splice(1, 0, `-p${password}`);
    }

    logger.debug({ event: "addToArchive.7zArgs", args: args.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
      js7z.callMain(args);
    });

    if (token?.isCancellationRequested) throw new CancelledError();
    const updated = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
    fs.writeFileSync(archivePath, Buffer.from(updated));

    logger.info({
      event: "addToArchive.ok",
      archivePath,
      files: localPaths.length,
      targetDir,
    });
  } finally {
    disposeJS7z(js7z);
  }
}

// ── Delete ──

export async function deleteFromArchiveCore(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
  token?: TokenLike,
): Promise<void> {
  const ext = getFullExt(archivePath);

  if (isWrappedFormat(ext)) {
    logger.info({ event: "deleteFromArchive.wrapped", archivePath, ext });
    return withWrappedArchiveCore(
      archivePath,
      password,
      async (js7z2) => {
        const dArgs = ["d", "/inner.tar", "-y"];
        if (password) {
          validatePassword(password);
          dArgs.splice(1, 0, `-p${password}`);
        }
        dArgs.push(...selectedPaths.map((p) => sanitizeCliPath(p.replace(/\\/g, "/"))));
        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d: ${c}`)));
          js7z2.callMain(dArgs);
        });
      },
      token,
    );
  }

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const archiveFsPath = streamToVFS(js7z, archivePath);

    const dArgs = ["d", archiveFsPath, "-y"];
    if (password) {
      validatePassword(password);
      dArgs.splice(1, 0, `-p${password}`);
    }
    dArgs.push(...selectedPaths.map((p) => sanitizeCliPath(p.replace(/\\/g, "/"))));
    logger.debug({ event: "deleteFromArchive.7zArgs", args: dArgs.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z d: ${c}`)));
      js7z.callMain(dArgs);
    });

    const updated = js7z.FS.readFile(archiveFsPath, { encoding: "binary" });
    logger.info({
      event: "deleteFromArchive.ok",
      archivePath,
      items: selectedPaths.length,
      newSizeBytes: updated.byteLength,
    });
    fs.writeFileSync(archivePath, Buffer.from(updated));
  } finally {
    disposeJS7z(js7z);
  }
}

// ── Rename ──

export async function renameInArchiveCore(
  archivePath: string,
  oldPath: string,
  newPath: string,
  password?: string,
  token?: TokenLike,
): Promise<void> {
  logger.info({ event: "rename.start", archivePath, oldPath, newPath });

  const ext = getFullExt(archivePath);
  if (isWrappedFormat(ext)) {
    logger.info({ event: "renameInWrapped.start", archivePath, oldPath, newPath });
    const oldNorm = oldPath.replace(/\\/g, "/");
    const newNorm = newPath.replace(/\\/g, "/");
    await withWrappedArchiveCore(
      archivePath,
      password,
      async (js7z2) => {
        const rnArgs = ["rn", "/inner.tar", sanitizeCliPath(oldNorm), sanitizeCliPath(newNorm)];
        if (password) {
          validatePassword(password);
          rnArgs.splice(1, 0, `-p${password}`);
        }
        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (c: number) =>
            c === 0 ? resolve() : reject(new Error(`7z rn inner: ${c}`));
          js7z2.callMain(rnArgs);
        });
      },
      token,
    );
    logger.info({ event: "renameInWrapped.ok", archivePath, oldPath, newPath });
    logger.info({ event: "renameInWrapped.ok", archivePath, oldPath, newPath });
    return;
  }

  checkFileSize(fs.statSync(archivePath).size);
  const oldNorm = oldPath.replace(/\\/g, "/");
  const newNorm = newPath.replace(/\\/g, "/");

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    const fsPath = streamToVFS(js7z, archivePath);
    const rnArgs = ["rn", fsPath, sanitizeCliPath(oldNorm), sanitizeCliPath(newNorm)];
    if (password) {
      validatePassword(password);
      rnArgs.splice(1, 0, `-p${password}`);
    }
    logger.debug({ event: "rename.7zArgs", args: rnArgs.join(" ") });

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z rn: ${c}`)));
      js7z.callMain(rnArgs);
    });

    if (token?.isCancellationRequested) throw new CancelledError();
    const updated = js7z.FS.readFile(fsPath, { encoding: "binary" });
    fs.writeFileSync(archivePath, Buffer.from(updated));
    logger.info({ event: "rename.ok", archivePath, oldPath, newPath });
  } finally {
    disposeJS7z(js7z);
  }
}

// ── Create folder ──

export async function createFolderInArchiveCore(
  archivePath: string,
  targetDir: string,
  folderName: string,
  password?: string,
  token?: TokenLike,
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
    return withWrappedArchiveCore(
      archivePath,
      password,
      async (js7z2) => {
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
        if (password) {
          validatePassword(password);
          aArgs.splice(1, 0, `-p${password}`);
        }
        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (c: number) =>
            c === 0 ? resolve() : reject(new Error(`7z a inner: ${c}`));
          js7z2.callMain(aArgs);
        });
      },
      token,
    );
  }

  checkFileSize(fs.statSync(archivePath).size);
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

    if (token?.isCancellationRequested) throw new CancelledError();
    const updated = js7z.FS.readFile(fsPath, { encoding: "binary" });
    fs.writeFileSync(archivePath, Buffer.from(updated));
    logger.info({ event: "createFolder.ok", archivePath, folderPath });
  } finally {
    disposeJS7z(js7z);
  }
}

// ── Preview ──

const MAX_PREVIEW_FILE_SIZE = 100 * 1024 * 1024; // 100 MB hard limit for preview

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

/**
 * Extract one file from an archive and write it to `outputPath`.
 * Returns the byte length written (0 if the file was not found / empty).
 */
export async function previewFileCore(
  archivePath: string,
  filePath: string,
  password: string | undefined,
  outputPath: string,
): Promise<void> {
  const archiveExt = getFullExt(archivePath);
  checkFileSize(fs.statSync(archivePath).size);
  logger.info({
    event: "previewFile.start",
    archivePath,
    file: filePath,
    sizeBytes: fs.statSync(archivePath).size,
  });

  const normalizedFile = filePath.replace(/\\/g, "/");

  let fileData: ArrayBuffer = new ArrayBuffer(0);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    let archiveFsPath: string;

    // js7z WASM doesn't support LZ4. For .tar.lz4, decompress manually
    // and feed the inner tar to 7z.
    if (archiveExt === ".tar.lz4" || archiveExt === ".tlz4") {
      const buf = fs.readFileSync(archivePath);
      const innerTar = await decompressLz4Frames(Buffer.from(buf));
      const tarName = path.basename(archivePath, archiveExt) + ".tar";
      archiveFsPath = `/${tarName}`;
      writeLargeVFS(js7z, archiveFsPath, innerTar);
    } else if (archiveExt === ".tar.br" || archiveExt === ".tbr") {
      // js7z WASM doesn't support Brotli. Decompress with node:zlib,
      // then feed the inner tar to 7z for extraction.
      const buf = fs.readFileSync(archivePath);
      const innerTar = brotliDecompress(new Uint8Array(buf));
      const tarName = path.basename(archivePath, archiveExt) + ".tar";
      archiveFsPath = `/${tarName}`;
      writeLargeVFS(js7z, archiveFsPath, innerTar);
    } else if (archiveExt === ".tar.sz" || archiveExt === ".tsz") {
      const buf = fs.readFileSync(archivePath);
      const innerTar = await snappyDecompress(new Uint8Array(buf));
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
        ".tar.sz",
        ".tsz",
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

  const buf = Buffer.from(fileData);
  if (buf.length > MAX_PREVIEW_FILE_SIZE) {
    throw new Error(t("preview.fileTooLarge", String(buf.length), String(MAX_PREVIEW_FILE_SIZE)));
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buf);
  logger.info({ event: "previewFile.ok", archivePath, filePath, outputPath });
}

// ── Test ──

export async function testArchiveCore(archivePath: string, password?: string): Promise<string> {
  logger.info({ event: "testArchive.start", archivePath });
  checkFileSize(fs.statSync(archivePath).size);
  const data = fs.readFileSync(archivePath);
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
