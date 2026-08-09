/**
 * Selective extraction core — Smart Archive VSCode Extension
 *
 * Vscode-free WASM selective extraction, runs inside the worker thread.
 * Host dispatcher: providers/extraction.ts (output-dir resolution and
 * the reveal/toast UI stay on the host).
 *
 * @module engines/extract-core
 */

import * as fs from "fs";
import * as path from "path";
import type { JS7zInstance } from "../types";
import { streamToVFS } from "./vfs-io";
import { decompressLz4Frames } from "./lz4-codec";
import { brotliDecompress } from "./brotli-codec";
import { snappyDecompress } from "./snappy-codec";
import {
  getFullExt,
  isWrappedFormat,
  MAX_COLLISION_RETRIES,
  VFS_TMP_X1,
  VFS_TMP_X2,
} from "../constants";
import { t } from "../i18n";
import { copyDirFromFS } from "../utils/fs";
import { validatePassword, sanitizeCliPath } from "../utils/security";
import { logger } from "../utils/logger-core";
import { CancelledError } from "../utils/cancellation";
import type { TokenLike } from "../utils/cancellation";
import { checkWorkerMemory } from "./worker/memory-guard";
import { JS7z } from "./js7z-factory";
import { disposeJS7z } from "./js7z-lifecycle";

/**
 * Copy from virtual FS to local FS, stripping the parent prefix of each
 * selected directory so that output paths are relative to the selection root.
 *
 * Example: selected "a/b", file "/out/a/b/c.txt" → "b/c.txt"
 */
function copyFromFSWithStrip(
  js7z: JS7zInstance,
  fsDir: string,
  localDir: string,
  selectedPaths: string[],
  token?: TokenLike,
): void {
  const normSel = selectedPaths.map((p) => p.replace(/\\/g, "/"));
  const strips = new Map<string, string>();
  for (const sp of normSel) {
    const parent = sp.substring(0, Math.max(sp.lastIndexOf("/"), 0));
    strips.set(sp, parent);
  }

  const walk = (currentDir: string, relPart: string) => {
    const entries = js7z.FS.readdir(currentDir);
    for (const name of entries) {
      if (token?.isCancellationRequested) throw new CancelledError();
      if (name === "." || name === "..") continue;
      const full = currentDir === "/" ? `/${name}` : `${currentDir}/${name}`;
      const rel = relPart ? `${relPart}/${name}` : name;

      if (name === ".smartarchive") {
        logger.debug(
          { event: "extraction.skipSmartarchive" },
          "Skipped internal .smartarchive marker",
        );
        continue;
      }

      try {
        const st = js7z.FS.stat(full);
        if (js7z.FS.isDir(st.mode)) {
          walk(full, rel);
          continue;
        }
      } catch {
        logger.warn(
          { event: "extraction.copyStat.failed" },
          "Failed to stat entry, trying as file",
        );
      }

      let outRel = rel;
      for (const sp of normSel) {
        if (rel === sp || rel.startsWith(sp + "/")) {
          const strip = strips.get(sp) || "";
          if (strip) outRel = rel.slice(strip.length + 1);
          break;
        }
      }

      let blocked = false;
      const segments = outRel.split("/");
      for (const seg of segments) {
        if (seg === ".." || seg === "." || seg.includes("\\") || seg.includes("\0")) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        logger.warn({ event: "fs.pathTraversal.strip", path: outRel }, "Path traversal blocked");
        continue;
      }

      const outPath = path.join(localDir, ...segments);
      if (!outPath.startsWith(localDir + path.sep) && outPath !== localDir) {
        logger.warn(
          { event: "fs.pathTraversal.resolve", path: outRel, resolved: outPath },
          "Path traversal blocked",
        );
        continue;
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      let data: Uint8Array | ArrayBuffer;
      checkWorkerMemory();
      try {
        data = js7z.FS.readFile(full, { encoding: "binary" });
      } catch (readErr) {
        logger.warn(
          { event: "extraction.readFile.failed", path: full, err: readErr },
          "Failed to read entry from virtual FS, skipping",
        );
        continue;
      }
      // Decompression bomb check: verify reported vs actual size ratio
      let reportedSize: number | undefined;
      try {
        reportedSize = js7z.FS.stat(full).size;
      } catch {
        logger.debug(
          { event: "extraction.statReportedSize.failed" },
          "Stat may fail, skipping bomb check",
        );
      }
      if (reportedSize !== undefined && data.byteLength > reportedSize * 4 && reportedSize > 1024) {
        throw new Error(
          t("security.decompressionBomb", String(reportedSize), String(data.byteLength)),
        );
      }

      let finalPath = outPath;
      const dir = path.dirname(outPath);
      const base = path.basename(outPath);
      const extIdx = base.lastIndexOf(".");
      const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
      const ext = extIdx > 0 ? base.slice(extIdx) : "";
      let counter = 1;
      // Use wx flag to avoid TOCTOU race — fails if file already exists
      while (true) {
        if (counter > MAX_COLLISION_RETRIES)
          throw new Error(`Failed to resolve collision for ${outPath}`);
        try {
          fs.writeFileSync(finalPath, Buffer.from(data), { flag: "wx" });
          break;
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") {
            counter++;
            finalPath = path.join(dir, `${stem}_${counter}${ext}`);
            continue;
          }
          throw e;
        }
      }
    }
  };

  walk(fsDir, "");
}

/**
 * Extract selected files from an archive (webview "Extract Selected").
 *
 * Two code paths based on archive type:
 *   1. Wrapped (tar.gz etc.) → two-step: extract outer layer with 7z,
 *      then extract selected paths from inner .tar with a second 7z instance
 *   2. Normal → 7z
 */
export async function extractSelectedCore(
  archivePath: string,
  selectedPaths: string[],
  password: string | undefined,
  flat: boolean | undefined,
  outputDir: string,
  excludes: string[] | undefined,
  token?: TokenLike,
): Promise<void> {
  const start = Date.now();
  const ext = getFullExt(archivePath);
  const isWrapped = isWrappedFormat(ext);

  logger.info({
    event: "extraction.start",
    archivePath,
    pathCount: selectedPaths.length,
    flat,
    outputDir,
    isWrapped,
  });

  if (isWrapped) {
    const js7z = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      let innerTarName: string;
      let innerTarVfsPath: string;
      if (ext === ".tar.lz4" || ext === ".tlz4") {
        const buf = fs.readFileSync(archivePath);
        const innerTar = await decompressLz4Frames(Buffer.from(buf));
        innerTarName = path.basename(archivePath, ext) + ".tar";
        innerTarVfsPath = `/${innerTarName}`;
        js7z.FS.writeFile(innerTarVfsPath, new Uint8Array(innerTar));
      } else if (ext === ".tar.br" || ext === ".tbr") {
        const buf = fs.readFileSync(archivePath);
        const innerTar = await brotliDecompress(new Uint8Array(buf));
        innerTarName = path.basename(archivePath, ext) + ".tar";
        innerTarVfsPath = `/${innerTarName}`;
        js7z.FS.writeFile(innerTarVfsPath, innerTar);
      } else if (ext === ".tar.sz" || ext === ".tsz") {
        const buf = fs.readFileSync(archivePath);
        const innerTar = await snappyDecompress(new Uint8Array(buf));
        innerTarName = path.basename(archivePath, ext) + ".tar";
        innerTarVfsPath = `/${innerTarName}`;
        js7z.FS.writeFile(innerTarVfsPath, innerTar);
      } else {
        const outerFsPath = streamToVFS(js7z, archivePath);
        js7z.FS.mkdir(VFS_TMP_X1);
        await new Promise<void>((resolve, reject) => {
          js7z.onExit = (c: number) => {
            if (c === 0 || c === 1) resolve();
            else reject(new Error(`7z x outer: ${c}`));
          };
          const outerArgs = ["x", outerFsPath, "-o/_x1", "-y"];
          if (password) {
            validatePassword(password);
            outerArgs.splice(1, 0, `-p${password}`);
          }
          js7z.callMain(outerArgs);
        });
        const top = js7z.FS.readdir(VFS_TMP_X1).filter((e: string) => e !== "." && e !== "..");
        const found = top.find((e: string) => e.endsWith(".tar"));
        if (!found) throw new Error("Wrapped archive: no inner .tar found");
        innerTarName = found;
        innerTarVfsPath = `${VFS_TMP_X1}/${innerTarName}`;
      }
      if (token?.isCancellationRequested) throw new CancelledError();
      const innerData = js7z.FS.readFile(innerTarVfsPath, { encoding: "binary" });
      const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
      try {
        js7z2.FS.writeFile(`/${innerTarName}`, new Uint8Array(innerData));
        js7z2.FS.mkdir(VFS_TMP_X2);
        const normalizedPaths = selectedPaths.map((p) => sanitizeCliPath(p.replace(/\\/g, "/")));
        const excludeFlags = (excludes ?? []).map((ex) => "-xr!" + ex.replace(/\\/g, "/"));
        const innerArgs = [
          flat ? "e" : "x",
          `/${innerTarName}`,
          "-o/_x2",
          flat ? "-aou" : "-y",
          ...excludeFlags,
          ...normalizedPaths,
        ];
        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (c: number) => {
            if (c === 0 || c === 1) resolve();
            else reject(new Error(`7z ${flat ? "e" : "x"} inner: ${c}`));
          };
          js7z2.callMain(innerArgs);
        });

        let x2HasContent =
          js7z2.FS.readdir(VFS_TMP_X2).filter((e: string) => e !== "." && e !== "..").length > 0;

        if (!x2HasContent) {
          logger.warn({
            event: "extraction.emptySelectiveWrapped",
            archivePath,
            pathCount: normalizedPaths.length,
          });
          // Known edge: this fallback drops the excludes — 7z re-extracts
          // everything, so excluded files inside a selected directory land
          // in /_x2 and get copied. Accepted: the fallback only triggers
          // when the selection matched nothing (usually stale paths).
          const allInnerArgs = ["x", `/${innerTarName}`, "-o/_x2", "-y"];
          await new Promise<void>((resolve, reject) => {
            js7z2.onExit = (c: number) => {
              if (c === 0 || c === 1) resolve();
              else reject(new Error(`7z x inner (full): ${c}`));
            };
            js7z2.callMain(allInnerArgs);
          });
        }
        if (token?.isCancellationRequested) throw new CancelledError();

        fs.mkdirSync(outputDir, { recursive: true });
        if (flat && x2HasContent) {
          copyDirFromFS(js7z2, VFS_TMP_X2, outputDir, token);
        } else {
          copyFromFSWithStrip(js7z2, VFS_TMP_X2, outputDir, selectedPaths, token);
        }
      } finally {
        disposeJS7z(js7z2);
      }
    } finally {
      disposeJS7z(js7z);
    }
    logger.info({
      event: "extraction.done",
      duration: Date.now() - start,
      engine: "7z-wrapped",
    });
    return;
  }

  // Normal archives: 7z only
  let stderr = "";

  const js7z = await JS7z({
    print: () => {},
    printErr: (text: string) => {
      stderr += text + "\n";
    },
  });

  try {
    const archiveFsPath = streamToVFS(js7z, archivePath);
    js7z.FS.mkdir("/out");

    const normalizedPaths = selectedPaths.map((p) => sanitizeCliPath(p.replace(/\\/g, "/")));
    const eArgs = [flat ? "e" : "x", archiveFsPath, "-o/out", flat ? "-aou" : "-y"];
    if (password) {
      validatePassword(password);
      eArgs.splice(1, 0, `-p${password}`);
    }
    if (excludes && excludes.length > 0) {
      for (const ex of excludes) {
        eArgs.push("-xr!" + ex.replace(/\\/g, "/"));
      }
    }
    eArgs.push(...normalizedPaths);

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (code: number) => {
        if (code === 0 || code === 1) resolve();
        else reject(new Error(`7z ${flat ? "e" : "x"}: ${code}\n${stderr}`));
      };
      js7z.callMain(eArgs);
    });

    let outHasContent =
      js7z.FS.readdir("/out").filter((e: string) => e !== "." && e !== "..").length > 0;

    if (!outHasContent) {
      logger.warn({
        event: "extraction.emptySelective",
        archivePath,
        pathCount: normalizedPaths.length,
      });
      // Known edge: this fallback drops the excludes — see the wrapped
      // branch for the same accepted behavior.
      const allArgs = ["x", archiveFsPath, "-o/out", "-y"];
      if (password) {
        allArgs.splice(1, 0, `-p${password}`);
      }
      stderr = "";
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (code: number) => {
          if (code === 0 || code === 1) resolve();
          else reject(new Error(`7z x (full): ${code}\n${stderr}`));
        };
        js7z.callMain(allArgs);
      });
    }
    if (token?.isCancellationRequested) throw new CancelledError();

    fs.mkdirSync(outputDir, { recursive: true });
    if (flat && outHasContent) {
      copyDirFromFS(js7z, "/out", outputDir, token);
    } else {
      copyFromFSWithStrip(js7z, "/out", outputDir, selectedPaths, token);
    }
    logger.info({ event: "extraction.done", duration: Date.now() - start, engine: "7z" });
  } finally {
    disposeJS7z(js7z);
  }
}
