/**
 * HTML Renderer — Smart Archive VSCode Extension
 *
 * Vue 3 + TanStack Virtual webview renderer.
 * Generates HTML pages that load the Vue app with archive data injected.
 *
 * @module providers/htmlRenderer
 */

import type { TreeNode } from "./treeBuilder";

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

function jsModule(uri: string, nonce: string): string {
  return `<script type="module" nonce="${nonce}" src="${uri}"></script>`;
}

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function cspMeta(nonce: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' vscode-webview-resource:; img-src data: vscode-webview-resource:; font-src vscode-webview-resource: data:; object-src 'none'; base-uri 'none'">`;
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
<body><div class="msg"><div class="sp"></div>Reading archive...</div></body></html>`;
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
<script type="application/json" id="_xTree">${JSON.stringify(tree)}</script>
<script type="application/json" id="_xFiles">${fileCount}</script>
<script type="application/json" id="_xDirs">${dirCount}</script>
<script type="application/json" id="_xProps">${JSON.stringify(props ?? null)}</script>
<script type="application/json" id="_xNoisy">${JSON.stringify(noisyPatterns ?? [])}</script>
${toast ? `<script type="application/json" id="_xToast">${JSON.stringify(toast)}</script>` : ""}
${viewState ? `<script type="application/json" id="_xViewState">${JSON.stringify(viewState)}</script>` : ""}
${jsModule(jsUri, n)}
</body></html>`;
}
