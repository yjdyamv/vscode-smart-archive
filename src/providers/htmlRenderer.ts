/**
 * HTML Renderer — Smart Archiver VSCode Extension
 *
 * Vue 3 + TanStack Virtual webview renderer.
 * Generates HTML pages that load the Vue app with archive data injected.
 *
 * @module providers/htmlRenderer
 */

import type { TreeNode } from "./treeBuilder";
import { t } from "../i18n";

/** Every user-visible string the webview chrome needs, keyed for injection. */
const UI_STRING_KEYS = [
  "ui.extract",
  "ui.delete",
  "ui.addFiles",
  "ui.addTo",
  "ui.archiveRoot",
  "ui.extractAll",
  "ui.convert",
  "ui.expandAll",
  "ui.collapseAll",
  "ui.selFiles",
  "ui.selDirs",
  "ui.name",
  "ui.size",
  "ui.filter",
  "ui.regex",
  "ui.searchPlaceholder",
  "ui.filterMode",
  "ui.regexMode",
  "ui.searchTitle",
  "ui.clearSearchTitle",
  "ui.clear",
  "ui.filteringFuzzy",
  "ui.filteringRegex",
  "ui.fuzzySearch",
  "ui.useRegex",
  "ui.merge",
  "ui.mergeTitle",
  "ui.split",
  "ui.splitTitle",
  "ui.decrypt",
  "ui.decryptTitle",
  "ui.encrypt",
  "ui.encryptTitle",
  "ui.testTitle",
  "ui.itemsLabel",
  "ui.filesLabel",
  "ui.dirsLabel",
  "ui.sizeLabel",
  "ui.ratioLabel",
  "ui.encryptedHint",
  "ui.password",
  "ui.unlock",
  "ui.wrongPassword",
  "ui.select",
  "ui.collapse",
  "ui.expand",
  "ui.readingArchive",
  "ui.failedToInit",
  "ui.noMatchingFiles",
  "ui.noMatchingHint",
  "ui.noFiles",
  "ui.match",
  "ui.matches",
  "ui.archive",
  "ui.copy",
  "ui.extractSelected",
  "ui.rename",
  "ui.addFilesHere",
  "ui.newFolder",
  "ui.root",
  "ui.item",
  "ui.items",
  "ui.file",
  "ui.dir",
  "ui.regexUnsafe",
] as const;

/** Resolve the webview string blob from the host locale (single source). */
export function webviewUiStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of UI_STRING_KEYS) out[key] = t(key);
  return out;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssLink(uri: string): string {
  return `<link rel="stylesheet" href="${uri}">`;
}

function jsModule(uri: string, n: string): string {
  return `<script type="module" nonce="${n}" src="${uri}"></script>`;
}

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function cspMeta(n: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline' vscode-webview-resource:; img-src data: vscode-webview-resource:; font-src vscode-webview-resource: data:; object-src 'none'; base-uri 'none'">`;
}

/**
 * Escape a JSON string for safe embedding inside a `<script>` element.
 * `</script>` (and `<!--`, `<script`) terminate a script element regardless
 * of its `type` attribute, so escaping `<` to its \\u003c JSON form prevents
 * an attacker-controlled entry name from breaking out of the data block.
 * Reads back identically via JSON.parse. Defense-in-depth alongside the CSP.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function emptyHtml(
  msg: string,
  cssUri?: string,
  jsUri?: string,
  codiconCssUri?: string,
): string {
  const n = nonce();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${cspMeta(n)}
${codiconCssUri ? cssLink(codiconCssUri) : ""}
${cssUri ? cssLink(cssUri) : ""}
</head>
<body><div style="text-align:center;color:var(--vscode-descriptionForeground);padding:4em 1.5em;font-size:var(--vscode-font-size)">${esc(msg)}</div>
${jsUri ? jsModule(jsUri, n) : ""}</body></html>`;
}

export function loadingHtml(codiconCssUri?: string): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${cspMeta(n)}
${codiconCssUri ? cssLink(codiconCssUri) : ""}
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .sp{width:24px;height:24px;border:3px solid var(--vscode-panel-border);border-top-color:var(--vscode-progressBar-background);border-radius:50%;animation:sp .8s linear infinite;margin-right:10px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .msg{display:flex;align-items:center;color:var(--vscode-descriptionForeground)}
</style></head>
<body><div class="msg"><div class="sp"></div>${t("ui.readingArchive")}</div></body></html>`;
}

export function contentHtml(
  tree: TreeNode[],
  fileCount: number,
  dirCount: number,
  cssUri: string,
  jsUri: string,
  codiconCssUri: string,
  props?: { name: string; format: string; count: number; size: string; ratio: number },
  noisyPatterns?: string[],
  toast?: string,
  viewState?: string,
): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${cspMeta(n)}
${cssLink(codiconCssUri)}
${cssLink(cssUri)}
</head>
<body>
<div id="app"></div>
<script type="application/json" id="_xTree">${escapeJsonForScript(JSON.stringify(tree))}</script>
<script type="application/json" id="_xFiles">${fileCount}</script>
<script type="application/json" id="_xDirs">${dirCount}</script>
<script type="application/json" id="_xProps">${escapeJsonForScript(JSON.stringify(props ?? null))}</script>
<script type="application/json" id="_xNoisy">${escapeJsonForScript(JSON.stringify(noisyPatterns ?? []))}</script>
<script type="application/json" id="_xStrings">${escapeJsonForScript(JSON.stringify(webviewUiStrings()))}</script>
${toast ? `<script type="application/json" id="_xToast">${escapeJsonForScript(JSON.stringify(toast))}</script>` : ""}
${viewState ? `<script type="application/json" id="_xViewState">${escapeJsonForScript(JSON.stringify(viewState))}</script>` : ""}
${jsModule(jsUri, n)}
</body></html>`;
}
