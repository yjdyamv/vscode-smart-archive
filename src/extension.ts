/**
 * Extension entry point — Smart Archive VSCode Extension
 *
 * Registers three commands (compress, decompress, browse) and the
 * custom archive viewer editor. All heavy lifting is delegated to
 * the commands/ and engines/ modules.
 *
 * @module extension
 */

import * as vscode from "vscode";
import * as path from "path";
import { compressCommand } from "./commands/compress";
import { repairCommand } from "./commands/repair";
import { rebuildVolumesCommand } from "./commands/rebuildVolumes";
import { decompressCommand, browseCommand } from "./commands/decompress";
import { registerArchiveEditor, pasteCopiedFromArchive } from "./providers/archiveProvider";
import { runAddToArchive } from "./providers/archive";
import { logger } from "./utils/logger";
import {
  init as initExpandedState,
  dispose as disposeExpandedState,
} from "./providers/webview/expandedState";
import { initTempCleanup } from "./providers/tempFiles";
import {
  clearListingCache,
  getListingCacheDir,
  initListingCache,
  sweepListingCache,
} from "./providers/listingCache";
import {
  clearPreviewCache,
  getPreviewCacheDir,
  initPreviewCache,
  sweepPreviewCache,
  type PreviewCacheConfig,
} from "./providers/previewCache";
import { initPasswordVault, disposePasswordVault } from "./providers/passwordVault";
import { resetDetectionCache } from "./engines/system7z";
import { applyHostConfig } from "./utils/config";
import { disposeBurstLoggers } from "./providers/webview/router";
import { resetArchiveRunner, reconfigureArchiveWorker } from "./engines/worker/runner";
import { t } from "./i18n";
import {
  CACHE_TEARDOWN_DELAY_MS,
  CACHE_VERSION_KEY,
  CLEAR_CACHES_COMMAND,
  CONFIG_MAX_FILES,
  CONFIG_MAX_MB,
  CONFIG_MAX_PREVIEW_MB,
  CONFIG_SECTION,
  CONFIG_TTL_DAYS,
  DAILY_CACHE_SWEEP_MS,
  LISTING_CACHE_DIR,
  PREVIEW_CACHE_DIR,
} from "./constants";

/**
 * Called when the extension is activated.
 * VSCode triggers this the first time either command is executed.
 *
 * @param context - Extension context for managing subscriptions
 */
export function activate(context: vscode.ExtensionContext): void {
  logger.info({ event: "extension.activate", vscode: vscode.version });

  // A re-activate cancels a pending teardown (update / re-enable).
  if (pendingCacheTeardown !== null) {
    clearTimeout(pendingCacheTeardown);
    pendingCacheTeardown = null;
  }

  applyHostConfig();

  // Cache lifecycle on extension update: the new version always activates,
  // so compare the version that last wrote the caches with this one and
  // clear on change — stale-format leftovers never survive an update.
  const version = context.extension.packageJSON.version as string | undefined;
  const lastVersion = context.globalState.get<string>(CACHE_VERSION_KEY);
  if (cacheVersionChanged(lastVersion, version)) {
    const preview = clearPreviewCache();
    const listing = clearListingCache();
    logger.info({
      event: "caches.clearedOnVersionChange",
      from: lastVersion,
      to: version,
      preview,
      listing,
    });
  }
  void context.globalState.update(CACHE_VERSION_KEY, version ?? "unknown");

  initExpandedState(context.secrets);
  initPasswordVault(context.secrets);
  initTempCleanup(context);
  initListingCache(path.join(context.globalStorageUri.fsPath, LISTING_CACHE_DIR));
  initPreviewCache(
    path.join(context.globalStorageUri.fsPath, PREVIEW_CACHE_DIR),
    readPreviewCacheConfig,
  );

  // Daily sweep: activation and post-store sweeps alone let expired files
  // linger while VS Code stays open without previews. A 24h timer keeps
  // the caches at their budget even in a long-lived session.
  const dailyCacheSweep = setInterval(() => {
    const previewDir = getPreviewCacheDir();
    if (previewDir) {
      const pruned = sweepPreviewCache(previewDir);
      if (pruned > 0) logger.info({ event: "previewCache.dailySweep", pruned });
    }
    const listingDir = getListingCacheDir();
    if (listingDir) {
      const pruned = sweepListingCache(listingDir);
      if (pruned > 0) logger.info({ event: "listingCache.dailySweep", pruned });
    }
  }, DAILY_CACHE_SWEEP_MS);
  context.subscriptions.push({ dispose: () => clearInterval(dailyCacheSweep) });

  // Invalidate the caches on demand.
  context.subscriptions.push(
    vscode.commands.registerCommand(CLEAR_CACHES_COMMAND, () => {
      const preview = clearPreviewCache();
      const listing = clearListingCache();
      logger.info({ event: "caches.cleared", preview, listing });
      void vscode.window.showInformationMessage(t("cache.cleared", String(preview + listing)));
    }),
  );

  // Register custom editor as default viewer for archive files (.7z, .zip, …)
  registerArchiveEditor(context);
  logger.info({ event: "extension.archiveProvider.registered" });

  // Invalidate cached engine detection when the relevant setting changes, so
  // switching sevenZBackend (e.g. to "bundled") applies without a window
  // reload. applyHostConfig already re-applies the other engine settings
  // (including zstd/rar5/snappy backend cache resets via engine-config).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      applyHostConfig();
      // Push the new values into a live worker too — without this, the
      // worker keeps stale limits/zstd settings until it is restarted.
      reconfigureArchiveWorker();
      if (e.affectsConfiguration("smart-archive.sevenZBackend")) resetDetectionCache();
    }),
  );

  // Register compress command
  const compressDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.compress",
    (uri: vscode.Uri, selectedUris: readonly vscode.Uri[]) => compressCommand(uri, selectedUris),
  );

  // Register decompress command
  const decompressDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.decompress",
    (uri: vscode.Uri, selectedUris: readonly vscode.Uri[]) => decompressCommand(uri, selectedUris),
  );

  // Register browse command
  const browseDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.browse",
    (uri: vscode.Uri) => browseCommand(uri),
  );

  // Register paste-from-archive command
  const pasteDisposable = vscode.commands.registerCommand("yjdyamv.smart-archive.paste", () =>
    pasteCopiedFromArchive(),
  );

  // Register repair command
  const repairDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.repair",
    (uri: vscode.Uri) => repairCommand(uri),
  );

  // Register rebuild-volumes command (RAR5 .rev recovery volumes)
  const rebuildVolumesDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.rebuildVolumes",
    (uri: vscode.Uri) => rebuildVolumesCommand(uri),
  );

  // Register add-to-archive command (triggered via command URI from webview)
  const addToArchiveDisposable = vscode.commands.registerCommand(
    "yjdyamv.smart-archive.addToArchive",
    () => runAddToArchive(),
  );

  // Dispose commands when the extension is deactivated
  context.subscriptions.push(
    compressDisposable,
    decompressDisposable,
    browseDisposable,
    pasteDisposable,
    addToArchiveDisposable,
    repairDisposable,
    rebuildVolumesDisposable,
  );
}

/**
 * Called when the extension is deactivated — on VS Code shutdown, disable,
 * uninstall, and before an update installs the new version. deactivate
 * gets no reason, so the caches cannot be cleared eagerly: a window close
 * must KEEP them (they are the point of a persistent cache). Instead a
 * delayed teardown timer is armed — if the extension host is still alive
 * after the grace period, the extension was disabled or uninstalled and
 * the caches are cleared; if the host exited (window closed) or the
 * extension was re-activated (update / re-enable), the timer never fires
 * or is cancelled. Best effort: a disabled-then-removed extension cannot
 * guarantee cleanup, and a host lingering past the window may clear
 * caches after a plain window close.
 */
export async function deactivate(): Promise<void> {
  disposeExpandedState();
  await disposePasswordVault();
  disposeBurstLoggers();
  resetArchiveRunner();
  pendingCacheTeardown = setTimeout(() => {
    pendingCacheTeardown = null;
    try {
      clearPreviewCache();
      clearListingCache();
    } catch {
      // Best effort — the logger is already disposed here.
    }
  }, CACHE_TEARDOWN_DELAY_MS);
  logger.info({ event: "extension.deactivate" });
  logger.dispose();
}

/** Deferred cache cleanup armed by deactivate (see its comment). */
let pendingCacheTeardown: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether an extension update invalidates the persisted caches: a known
 * previous version that differs from the current one. First install
 * (undefined previous) keeps whatever exists — nothing was ours.
 */
export function cacheVersionChanged(
  previousVersion: string | undefined,
  currentVersion: string | undefined,
): boolean {
  return previousVersion !== undefined && previousVersion !== currentVersion;
}

/**
 * Live-read the preview-cache disk budget from VS Code settings (MB-based
 * for humans, bytes internally). Called on every store/sweep, so changing
 * a setting applies immediately. maxPreviewMB: 0 disables the persistent
 * cache entirely.
 */
function readPreviewCacheConfig(): Partial<PreviewCacheConfig> {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const maxPreviewMB = c.get<number>(CONFIG_MAX_PREVIEW_MB, 10);
  return {
    maxCacheableBytes: maxPreviewMB <= 0 ? 0 : maxPreviewMB * 1024 * 1024,
    ttlMs: c.get<number>(CONFIG_TTL_DAYS, 30) * 24 * 60 * 60 * 1000,
    maxBytes: c.get<number>(CONFIG_MAX_MB, 1024) * 1024 * 1024,
    maxFiles: c.get<number>(CONFIG_MAX_FILES, 100),
  };
}
