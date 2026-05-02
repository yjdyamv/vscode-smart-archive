/**
 * Extraction — Smart Archive VSCode Extension
 *
 * Core selective-extraction function with three code paths:
 * RAR → libarchive, wrapped formats → two-step 7z, normal → 7z + fallback.
 * Also contains the VFS-to-local copy helper with prefix stripping.
 *
 * @module providers/extraction
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { JS7zInstance } from "../types";
import { JS7z, tryCleanupJS7z } from "./fileListing";
import { extractSelectedFiles } from "../engines/libarchive-engine";
import { getFullExt, isWrappedFormat } from "../constants";
import { isRarExt } from "../utils/rar";
import { t } from "../i18n";
import { getOutputPath, copyDirFromFS } from "../utils/fs";
import { checkFileSize } from "../utils/security";
import { logger } from "../utils/logger";

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
      if (name === "." || name === "..") continue;
      const full = currentDir === "/" ? `/${name}` : `${currentDir}/${name}`;
      const rel = relPart ? `${relPart}/${name}` : name;

      try {
        const st = js7z.FS.stat(full);
        if (js7z.FS.isDir(st.mode)) {
          walk(full, rel);
          continue;
        }
      } catch {
        logger.warn(
          { event: "extractSelected.copyStat.failed" },
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
      try {
        data = js7z.FS.readFile(full, { encoding: "binary" });
      } catch (readErr) {
        logger.warn(
          { event: "extractSelected.readFile.failed", path: full, err: readErr },
          "Failed to read entry from virtual FS, skipping",
        );
        continue;
      }
      checkFileSize(data.byteLength);

      let finalPath = outPath;
      const dir = path.dirname(outPath);
      const base = path.basename(outPath);
      const extIdx = base.lastIndexOf(".");
      const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
      const ext = extIdx > 0 ? base.slice(extIdx) : "";
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        if (counter > 999) throw new Error(`Failed to resolve collision for ${outPath}`);
        finalPath = path.join(dir, `${stem}_${counter}${ext}`);
        counter++;
      }

      fs.writeFileSync(finalPath, Buffer.from(data));
    }
  };

  walk(fsDir, "");
}

/**
 * Extract selected files from an archive (webview "Extract Selected").
 *
 * Three code paths based on archive type:
 *   1. RAR → libarchive only (7z cannot read RAR at all)
 *   2. Wrapped (tar.gz etc.) → two-step: extract outer layer with 7z,
 *      then extract selected paths from inner .tar with a second 7z instance
 *   3. Normal → 7z first, fall back to libarchive on failure
 */
async function extractSelected(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
  flat?: boolean,
  outputOverride?: string,
  excludes?: string[],
): Promise<void> {
  const start = Date.now();
  const ext = getFullExt(archivePath);
  const rarExt = isRarExt(ext);
  const isWrapped = isWrappedFormat(ext);
  const outputDir = outputOverride || getOutputPath(archivePath, "extracted");

  logger.info({
    event: "extractSelected.enter",
    archivePath,
    pathCount: selectedPaths.length,
    flat,
    outputDir,
    isRar: rarExt,
    isWrapped,
  });

  if (rarExt) {
    fs.mkdirSync(outputDir, { recursive: true });
    const count = await extractSelectedFiles(
      archivePath,
      outputDir,
      selectedPaths,
      password || undefined,
    );
    vscode.window.showInformationMessage(t("decompress.rarDone", String(count)) + outputDir);
    if (fs.existsSync(outputDir)) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
    }
    logger.info({
      event: "extractSelected.exit",
      duration: Date.now() - start,
      engine: "libarchive",
    });
    return;
  }

  if (isWrapped) {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
    const archiveName = path.basename(archivePath);
    const js7z = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      js7z.FS.writeFile(`/${archiveName}`, data);
      js7z.FS.mkdir("/_x1");
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (c: number) => {
          if (c === 0) resolve();
          else reject(new Error(`7z x outer: ${c}`));
        };
        const outerArgs = ["x", `/${archiveName}`, "-o/_x1", "-y"];
        if (password) outerArgs.splice(1, 0, `-p${password}`);
        js7z.callMain(outerArgs);
      });
      const top = js7z.FS.readdir("/_x1").filter((e: string) => e !== "." && e !== "..");
      const innerTar = top.find((e: string) => e.endsWith(".tar"));
      if (!innerTar) throw new Error("Wrapped archive: no inner .tar found");
      const innerData = js7z.FS.readFile(`/_x1/${innerTar}`, { encoding: "binary" });
      const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
      try {
        js7z2.FS.writeFile(`/${innerTar}`, new Uint8Array(innerData));
        js7z2.FS.mkdir("/_x2");
        const normalizedPaths = selectedPaths.map((p) => p.replace(/\\/g, "/"));
        const excludeFlags = (excludes ?? []).map((ex) => "-xr!" + ex.replace(/\\/g, "/"));
        await new Promise<void>((resolve, reject) => {
          js7z2.onExit = (c: number) => {
            if (c === 0) resolve();
            else reject(new Error(`7z ${flat ? "e" : "x"} inner: ${c}`));
          };
          js7z2.callMain([
            flat ? "e" : "x",
            `/${innerTar}`,
            "-o/_x2",
            flat ? "-aou" : "-y",
            ...normalizedPaths,
            ...excludeFlags,
          ]);
        });
        fs.mkdirSync(outputDir, { recursive: true });
        if (flat) {
          copyDirFromFS(js7z2, "/_x2", outputDir);
        } else {
          copyFromFSWithStrip(js7z2, "/_x2", outputDir, selectedPaths);
        }
        if (fs.existsSync(outputDir)) {
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
        }
        vscode.window.showInformationMessage(t("decompress.done") + outputDir);
      } finally {
        tryCleanupJS7z(js7z2);
      }
    } finally {
      tryCleanupJS7z(js7z);
    }
    logger.info({
      event: "extractSelected.exit",
      duration: Date.now() - start,
      engine: "7z-wrapped",
    });
    return;
  }

  // Non-RAR archives: try 7z first, fall back to libarchive
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);
  let stderr = "";

  const js7z = await JS7z({
    print: () => {},
    printErr: (text: string) => {
      stderr += text + "\n";
    },
  });

  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    js7z.FS.mkdir("/out");

    try {
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`7z ${flat ? "e" : "x"}: ${code}\n${stderr}`));
        };
        const normalizedPaths = selectedPaths.map((p) => p.replace(/\\/g, "/"));
        const eArgs = [flat ? "e" : "x", `/${archiveName}`, "-o/out", flat ? "-aou" : "-y"];
        if (password) eArgs.splice(1, 0, `-p${password}`);
        eArgs.push(...normalizedPaths);
        // Add exclusion flags for deselected children
        if (excludes && excludes.length > 0) {
          for (const ex of excludes) {
            eArgs.push("-xr!" + ex.replace(/\\/g, "/"));
          }
        }
        js7z.callMain(eArgs);
      });
      fs.mkdirSync(outputDir, { recursive: true });
      if (flat) {
        copyDirFromFS(js7z, "/out", outputDir);
      } else {
        copyFromFSWithStrip(js7z, "/out", outputDir, selectedPaths);
      }
      if (fs.existsSync(outputDir)) {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
      }
      vscode.window.showInformationMessage(t("decompress.done") + outputDir);
      logger.info({ event: "extractSelected.exit", duration: Date.now() - start, engine: "7z" });
    } catch (err) {
      logger.warn({ event: "extractSelected.fallback", err }, (err as Error).message);
      try {
        const count = await extractSelectedFiles(archivePath, outputDir, selectedPaths);
        vscode.window.showInformationMessage(t("decompress.rarDone", String(count)) + outputDir);
        if (fs.existsSync(outputDir)) {
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
        }
        logger.info({
          event: "extractSelected.exit",
          duration: Date.now() - start,
          engine: "libarchive",
        });
      } catch (fallbackErr) {
        logger.error(
          { event: "extractSelected.fallback.failed", err: fallbackErr },
          "Fallback extraction failed",
        );
        // eslint-disable-next-line preserve-caught-error
        throw new Error(
          t("decompress.failed") +
            `\n7z: ${(err as Error).message}\nlibarchive: ${(fallbackErr as Error).message}`,
        );
      }
    }
  } finally {
    tryCleanupJS7z(js7z);
  }
}

export { copyFromFSWithStrip, extractSelected };
