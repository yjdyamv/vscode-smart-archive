/**
 * Seam manifest — Smart Archive VSCode Extension
 *
 * One machine-checked record of which production module each test file
 * reaches. Every module under src/ is registered here — either with the
 * test files that import it, or as a `gap` with an explicit reason.
 * test/seam-coverage.test.ts fails when:
 *   - a new src module is added without registering it here
 *   - a registered test file stops importing its module (drift)
 *   - a gap entry is stale (module now imported) or has no reason
 *
 * The covered map is derived from `../src/...` imports in test/ files
 * (barrels count: api.test.ts imports "../src/api"). Do not edit the
 * covered section by hand — move modules between covered and gaps by
 * adding/removing test imports.
 */

export const SEAM_COVERED: Record<string, string[]> = {
  "src/api/compress.ts": [
    "api.test.ts",
    "rar5-exclusion.test.ts"
  ],
  "src/api/decompress.ts": [
    "api.test.ts"
  ],
  "src/commands/compress.ts": [
    "commands-e2e.test.ts",
    "wizard.test.ts"
  ],
  "src/commands/decompress.ts": [
    "commands-e2e.test.ts"
  ],
  "src/commands/repair.ts": [
    "commands-e2e.test.ts"
  ],
  "src/commands/rebuildVolumes.ts": [
    "rebuild-volumes.test.ts"
  ],
  "src/constants.ts": [
    "defaults-consistency.test.ts",
    "preview.test.ts",
    "rar5-exclusion.test.ts",
    "security-exclusion.test.ts",
    "shared-setup.ts",
    "workspace.test.ts"
  ],
  "src/engines/brotli-codec.ts": [
    "codec-progress.test.ts",
    "preview.test.ts",
    "security-exclusion.test.ts",
    "shared-setup.ts",
    "wasm-codec.test.ts"
  ],
  "src/engines/bundled7z.ts": [
    "api.test.ts",
    "commands-e2e.test.ts",
    "gates.ts",
    "system7z-rar.test.ts",
    "verify.ts"
  ],
  "src/engines/engine-config.ts": [
    "backend-config.test.ts",
    "codec-progress.test.ts",
    "defaults-consistency.test.ts"
  ],
  "src/engines/extract-core.ts": [
    "extract-wrapped.test.ts"
  ],
  "src/engines/fileListing-core.ts": [
    "wasm-codec-pipeline.test.ts"
  ],
  "src/engines/js7z-codec.ts": [
    "codec-progress.test.ts",
    "helpers.ts",
    "preview.test.ts",
    "shared-setup.ts",
    "wasm-codec-pipeline.test.ts",
    "wasm-codec.test.ts"
  ],
  "src/engines/js7z-compress-core.ts": [
    "wasm-codec-pipeline.test.ts"
  ],
  "src/engines/js7z-compress.ts": [
    "pipeline-progress.test.ts",
    "wizard.test.ts"
  ],
  "src/engines/js7z-decompress-core.ts": [
    "wasm-codec-pipeline.test.ts"
  ],
  "src/engines/js7z-decompress.ts": [
    "single-file-stream.test.ts"
  ],
  "src/engines/js7z-factory.ts": [
    "helpers.ts",
    "js7z-factory.test.ts",
    "preview.test.ts",
    "workspace.test.ts"
  ],
  "src/engines/js7z-list-core.ts": [
    "shared-setup.ts"
  ],
  "src/engines/lz4-codec.ts": [
    "codec-progress.test.ts",
    "wasm-codec.test.ts"
  ],
  "src/engines/modify-core.ts": [
    "wasm-codec-pipeline.test.ts"
  ],
  "src/engines/rar5-engine.ts": [
    "backend-config.test.ts",
    "commands-e2e.test.ts",
    "rar5-modify.test.ts",
    "rar5-progress.test.ts",
    "rar5-rebuild-e2e.test.ts",
    "rar5-wasm.test.ts"
  ],
  "src/engines/select-engine.ts": [
    "select-engine.test.ts"
  ],
  "src/engines/snappy-codec.ts": [
    "backend-config.test.ts",
    "codec-progress.test.ts"
  ],
  "src/engines/system7z.ts": [
    "api.test.ts",
    "delete-progress.test.ts",
    "gates.ts",
    "pipeline-progress.test.ts",
    "rar5-modify.test.ts",
    "select-engine.test.ts",
    "system7z-rar.test.ts",
    "system7z.test.ts"
  ],
  "src/engines/tar-writer.ts": [
    "compress-decompress.test.ts"
  ],
  "src/engines/worker/handler.ts": [
    "worker.test.ts"
  ],
  "src/engines/worker/runner.ts": [
    "runner.test.ts",
    "setupRunner.ts"
  ],
  "src/engines/worker/types.ts": [
    "backend-config.test.ts",
    "worker.test.ts"
  ],
  "src/engines/zstd-codec.ts": [
    "codec-progress.test.ts"
  ],
  "src/i18n.ts": [
    "i18n.test.ts"
  ],
  "src/providers/archive/modify.ts": [
    "single-file-stream.test.ts"
  ],
  "src/providers/archive/rar5-modify.ts": [
    "rar5-modify.test.ts",
    "rar5-rebuild-e2e.test.ts"
  ],
  "src/providers/fileListing.ts": [
    "single-file-stream.test.ts"
  ],
  "src/providers/listingCache.ts": [
    "listing-cache.test.ts"
  ],
  "src/providers/passwordVault.ts": [
    "password-vault.test.ts",
    "setup-encrypted.test.ts"
  ],
  "src/providers/previewCache.ts": [
    "preview-cache.test.ts",
    "single-file-stream.test.ts"
  ],
  "src/providers/tempFiles.ts": [
    "single-file-stream.test.ts"
  ],
  "src/providers/treeBuilder.ts": [
    "preview.test.ts",
    "shared-setup.ts"
  ],
  "src/services/archiveService.ts": [
    "setup-split-rar.test.ts"
  ],
  "src/providers/webview/handlers/decrypt.ts": [
    "webview-encrypt-decrypt.test.ts"
  ],
  "src/providers/webview/handlers/encrypt.ts": [
    "webview-encrypt-decrypt.test.ts"
  ],
  "src/providers/webview/handlers/shared.ts": [
    "rar5-rebuild-e2e.test.ts"
  ],
  "src/providers/webview/handlers/split.ts": [
    "webview-split.test.ts"
  ],
  "src/providers/webview/setup.ts": [
    "setup-encrypted.test.ts",
    "setup-split-rar.test.ts"
  ],
  "src/providers/webview/helpers.ts": [
    "workspace.test.ts"
  ],
  "src/providers/webview/router.ts": [
    "router-burst.test.ts",
    "split-volume.test.ts"
  ],
  "src/utils/errors.ts": [
    "preview-oversize.test.ts"
  ],
  "src/utils/exclude.ts": [
    "rar5-modify.test.ts"
  ],
  "src/utils/format.ts": [
    "shared-setup.ts"
  ],
  "src/utils/fs.ts": [
    "compress-decompress.test.ts"
  ],
  "src/utils/log-history.ts": [
    "log-history.test.ts"
  ],
  "src/utils/logger-core.ts": [
    "logger.test.ts"
  ],
  "src/utils/logger.ts": [
    "logger.test.ts",
    "router-burst.test.ts"
  ],
  "src/utils/noisy-patterns.ts": [
    "preview.test.ts"
  ],
  "src/utils/parse7z.ts": [
    "parse7z.test.ts",
    "preview.test.ts",
    "tree-format.test.ts",
    "workspace.test.ts"
  ],
  "src/utils/path.ts": [
    "encoding-recovery.test.ts",
    "shared-setup.ts"
  ],
  "src/utils/rar.ts": [
    "shared-setup.ts"
  ],
  "src/utils/security.ts": [
    "defaults-consistency.test.ts",
    "security-exclusion.test.ts",
    "shared-setup.ts"
  ],
  "src/utils/volume-sizes.ts": [
    "volume-sizes.test.ts"
  ],
  "src/extension.ts": [
    "cache-lifecycle.test.ts"
  ]
};

export const SEAM_GAPS: Record<string, string> = {
  "src/api/index.ts": "re-export barrel — api/compress.ts + api/decompress.ts covered",
  "src/engines/js7z-helpers.ts": "WASM primitives — exercised transitively by every WASM op",
  "src/engines/js7z-lifecycle.ts": "dispose lifecycle — exercised via helpers.disposeJS7z path",
  "src/engines/js7z-list.ts": "host list dispatcher — exercised via decompress isEncrypted flow",
  "src/engines/native-codec.ts": "native 7zz codec fallback — needs staged 7zz with codecs",
  "src/engines/vfs-io.ts": "WASM VFS staging — exercised transitively by every WASM op",
  "src/engines/worker/dispatch.ts": "op→core table — exercised via worker.test.ts + InProcessRunner",
  "src/engines/worker/memory-guard.ts": "RSS limit enforcement untested",
  "src/engines/worker/worker.ts": "thread entry — protocol tested via FakePort (worker.test.ts)",
  "src/providers/archive/add.ts": "webview add-to-archive op — untested",
  "src/providers/archive/delete.ts": "webview delete op — untested",
  "src/providers/archive/index.ts": "re-export barrel",
  "src/providers/archiveProvider.ts": "custom-editor registration — needs deeper vscode double",
  "src/providers/copyPaste.ts": "webview clipboard ops — untested",
  "src/providers/extraction.ts": "webview extraction ops — untested",
  "src/providers/htmlRenderer.ts": "webview html — untested",
  "src/providers/webview/expandedState.ts": "webview state — untested",
  "src/providers/webview/handlers/addFiles.ts": "webview handler — untested",
  "src/providers/webview/handlers/convert.ts": "webview handler — untested",
  "src/providers/webview/handlers/copy.ts": "webview handler — untested",
  "src/providers/webview/handlers/deleteEntries.ts": "webview handler — untested",
  "src/providers/webview/handlers/extractAll.ts": "webview handler — untested",
  "src/providers/webview/handlers/extractSelected.ts": "webview handler — untested",
  "src/providers/webview/handlers/index.ts": "re-export barrel",
  "src/providers/webview/handlers/merge.ts": "webview handler — untested",
  "src/providers/webview/handlers/newFolder.ts": "webview handler — untested",
  "src/providers/webview/handlers/password.ts": "webview handler — untested",
  "src/providers/webview/handlers/preview.ts": "webview handler — untested",
  "src/providers/webview/handlers/rename.ts": "webview handler — untested",
  "src/providers/webview/handlers/test.ts": "webview handler — untested",
  "src/providers/webview/handlers/types.ts": "type-only",
  "src/providers/webview/state.ts": "webview state — untested",
  "src/providers/webviewHandler.ts": "webview message routing — untested",
  "src/types/index.ts": "type-only",
  "src/ui/prompts.ts": "password/save dialogs — exercised via wizard + commands flows",
  "src/ui/stage-progress.ts": "progress staging — untested",
  "src/utils/cancellation.ts": "TokenLike/ProgressLike structural types",
  "src/utils/config.ts": "host config reads — partially via commands-e2e",
  "src/utils/errorClassifier.ts": "error classification — untested",
  "src/utils/platform.ts": "platform helpers — untested",
  "src/utils/progress-scale.ts": "progress scaling — untested",
  "src/utils/promptOversize.ts": "oversize dialog — exercised via decompress command flow",
  "src/utils/sevenZipMethod.ts": "7z method strings — untested",
  "src/utils/volume-sizes-core.ts": "volume size lists — split-volume tests use router path"
};
