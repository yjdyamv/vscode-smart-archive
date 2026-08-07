/**
 * Extraction dispatcher — Smart Archive VSCode Extension
 *
 * Host-side entry point for selective extraction. Resolves the output
 * directory, runs the WASM extraction in the worker thread
 * (engines/extract-core), then reveals the result in the OS.
 *
 * @module providers/extraction
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getFullExt } from "../constants";
import { t } from "../i18n";
import { getOutputPath } from "../utils/fs";
import { logger } from "../utils/logger";
import { runArchiveOp } from "../engines/worker/runner";

/**
 * Extract selected files from an archive (webview "Extract Selected").
 */
export async function extractSelected(
  archivePath: string,
  selectedPaths: string[],
  password?: string,
  flat?: boolean,
  outputOverride?: string,
  excludes?: string[],
): Promise<void> {
  const ext = getFullExt(archivePath);
  const rawOutputDir = outputOverride || getOutputPath(archivePath, "extracted");
  const outputDir = path.resolve(rawOutputDir);

  logger.info({
    event: "extraction.start",
    archivePath,
    pathCount: selectedPaths.length,
    flat,
    outputDir,
    ext,
  });

  await runArchiveOp("modify", {
    action: "extract",
    archivePath,
    paths: selectedPaths,
    password,
    flat,
    outputDir,
    excludes,
  });

  if (fs.existsSync(outputDir)) {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
  }
  vscode.window.showInformationMessage(t("decompress.done") + outputDir);
}
