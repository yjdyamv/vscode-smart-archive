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

function jsModule(uri: string): string {
  return `<script type="module" src="${uri}"></script>`;
}

export function emptyHtml(msg: string, cssUri?: string, jsUri?: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${cssUri ? cssLink(cssUri) : ""}
</head>
<body><div style="text-align:center;color:var(--vscode-descriptionForeground);padding:4em 1.5em;font-size:var(--vscode-font-size)">${esc(msg)}</div>
${jsUri ? jsModule(jsUri) : ""}</body></html>`;
}

export function passwordHtml(archiveName: string, cssUri?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${cssUri ? cssLink(cssUri) : ""}
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .pw-box{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:10px}
  .pw-box input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px 36px 6px 12px;border-radius:3px;font-size:var(--vscode-font-size);width:248px;transition:border-color .2s}
  .pw-box input.err{border-color:var(--vscode-inputValidation-errorBorder,#e51400);box-shadow:0 0 0 1px var(--vscode-inputValidation-errorBorder,#e5140033)}
  .pw-box input:focus{outline:1px solid var(--vscode-focusBorder)}
  .pw-inp{position:relative;display:flex;align-items:center}
  .pw-eye,.pw-clr{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:14px;padding:2px 4px;line-height:1}
  .pw-clr{right:28px}
  .pw-eye:hover,.pw-clr:hover{color:var(--vscode-foreground)}
  .btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:2px 8px;border-radius:2px;cursor:pointer;font-size:calc(var(--vscode-font-size)*.92);margin-top:4px}
  .btn:hover{background:var(--vscode-button-hoverBackground)}
   .pw-err{color:var(--vscode-inputValidation-errorForeground,#f14c4c);font-size:calc(var(--vscode-font-size)*.92);min-height:1.4em;opacity:0;transition:opacity .2s}
  .pw-err.on{opacity:1}
</style></head>
<body>
<div class="pw-box">
  <div style="font-size:3em">&#x1F512;</div>
  <div style="color:var(--vscode-foreground);font-size:calc(var(--vscode-font-size)*1.1)">${esc(archiveName)}</div>
  <div style="color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size)*.92);margin-bottom:4px">Encrypted &mdash; enter password</div>
  <div class="pw-inp">
    <input id="pw" type="password" placeholder="Password" autofocus onkeydown="if(event.key==='Enter'||event.keyCode===13)submitPw()">
    <button class="pw-clr" title="Clear" onclick="var i=document.getElementById('pw');i.value='';i.focus();i.classList.remove('err');document.getElementById('pwe').classList.remove('on')">&#x2715;</button>
    <button class="pw-eye" title="Show password" onmousedown="document.getElementById('pw').type='text'" onmouseup="document.getElementById('pw').type='password'" onmouseleave="document.getElementById('pw').type='password'">&#x1F441;</button>
  </div>
  <button class="btn" onclick="submitPw()">Unlock</button>
  <div id="pwe" class="pw-err">Wrong password</div>
</div>
<script>
var v=acquireVsCodeApi();
function submitPw(){var i=document.getElementById('pw'),pw=i.value;if(!pw)return;i.classList.remove('err');document.getElementById('pwe').classList.remove('on');v.postMessage({c:'pw',pw:pw})}
window.addEventListener('message',function(e){if(e.data.c==='pwerr'){document.getElementById('pw').classList.add('err');document.getElementById('pwe').classList.add('on');document.getElementById('pwe').textContent=e.data.t||'Wrong password'}});
</script>
</body></html>`;
}

export function loadingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  props?: { name: string; format: string; count: number; size: string },
  noisyPatterns?: string[],
): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${cssLink(cssUri)}
</head>
<body>
<div id="app"></div>
<script>window._xTree=${JSON.stringify(tree)}</script>
<script>window._xFiles=${fileCount}</script>
<script>window._xDirs=${dirCount}</script>
<script>window._xProps=${JSON.stringify(props ?? null)}</script>
<script>window._xNoisy=${JSON.stringify(noisyPatterns ?? [])}</script>
${jsModule(jsUri)}
</body></html>`;
}
