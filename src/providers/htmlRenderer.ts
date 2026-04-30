/**
 * HTML renderer — Smart Archive VSCode Extension
 *
 * Generates full HTML pages for the archive browser webview.
 * CSS and JS are loaded from separate files via webview URIs
 * for proper caching and devtools debugging.
 *
 * @module providers/htmlRenderer
 */

import type { TreeNode } from "./treeBuilder";
import { fileIcon } from "./fileIcons";
import { t, formatCompactSize } from "../i18n";

const INDENT_PX = 16;

// ── Escaping ───────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Tree Rendering ──────────────────────────────────────────────────

function renderRow(node: TreeNode, depth: number): string {
  const isDir = node.kind === "DIRECTORY";
  const hasKids = isDir && node.children && node.children.length > 0;
  const { color, emoji } = fileIcon(node.name, isDir);
  const size =
    !isDir && node.size > 0 ? `<span class='sz'>${formatCompactSize(node.size)}</span>` : "";

  let guides = "";
  for (let i = 0; i < depth; i++) {
    guides += `<span class='gd' style='left:${i * INDENT_PX + INDENT_PX / 2}px'></span>`;
  }

  return (
    `<div class='rw${isDir ? " dir" : ""}' style='padding-left:${depth * INDENT_PX}px' data-path='${esc(node.path)}' data-name='${esc(node.name)}' data-size='${node.size}'` +
    (hasKids ? " onclick='togDir(event,this)'" : " onclick='selRow(event,this)'") +
    ">" +
    guides +
    "<span class='cb' onclick='selOne(event)'><span class='ck'></span></span>" +
    `<span class='ar'>${hasKids ? "\u25BC" : isDir ? "\u25B6" : ""}</span>` +
    `<span class='ic' style='color:${color}'>${emoji}</span>` +
    `<span class='nm' title='${esc(node.path)}'>${esc(node.name)}</span>` +
    size +
    "</div>"
  );
}

function renderTree(nodes: TreeNode[], depth: number): string {
  let html = "";
  for (const node of nodes) {
    html += renderRow(node, depth);
    if (node.children && node.children.length > 0) {
      html += `<div class='grp'>${renderTree(node.children, depth + 1)}</div>`;
    }
  }
  return html;
}

// ── URI helpers ─────────────────────────────────────────────────────

function cssLink(uri: string | undefined): string {
  if (!uri) return "";
  return `<link rel='stylesheet' href='${uri}'>`;
}

function jsScript(uri: string | undefined): string {
  if (!uri) return "";
  return `<script src='${uri}'></script>`;
}

// ── HTML Page Generators ────────────────────────────────────────────

export function emptyHtml(msg: string, cssUri?: string, jsUri?: string): string {
  return `<!DOCTYPE html><html><head><meta charset='UTF-8'>
${cssLink(cssUri)}</head>
<body><div class='empty'>${esc(msg)}</div>
${jsScript(jsUri)}</body></html>`;
}

export function passwordHtml(archiveName: string, cssUri?: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset='UTF-8'>
${cssLink(cssUri)}</head>
<body>
<div class='pw-box'>
  <div style='font-size:3em'>\u{1F512}</div>
  <div style='color:var(--vscode-foreground);font-size:calc(var(--vscode-font-size) * 1.1)'>${esc(archiveName)}</div>
  <div style='color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size) * 0.92);margin-bottom:4px'>Encrypted \u2014 enter password</div>
  <div class='pw-inp'>
    <input id='pw' type='password' placeholder='Password' autofocus onkeydown='if(event.key==="Enter"||event.keyCode===13)submitPw()'>
    <button class='pw-clr' title='Clear' onclick='var i=document.getElementById("pw");i.value="";i.focus();i.classList.remove("err");document.getElementById("pwe").classList.remove("on")'>\u2715</button>
    <button class='pw-eye' title='Show password' onmousedown='document.getElementById("pw").type="text"' onmouseup='document.getElementById("pw").type="password"' onmouseleave='document.getElementById("pw").type="password"'>\u{1F441}</button>
  </div>
  <button class='btn' onclick='submitPw()' style='margin-top:4px'>Unlock</button>
  <div id='pwe' class='pw-err'>Wrong password</div>
</div>
<script>
var v=acquireVsCodeApi();
function submitPw(){
  var el=document.getElementById('pw'),pw=el.value;
  if(!pw)return;
  el.classList.remove('err');document.getElementById('pwe').classList.remove('on');
  v.postMessage({c:'pw',pw:pw})
}
window.addEventListener('message',function(e){
  if(e.data.c==='pwerr'){
    document.getElementById('pw').classList.add('err');
    document.getElementById('pwe').classList.add('on');
    document.getElementById('pwe').textContent=e.data.t || 'Wrong password'
  }
});
</script>
</body></html>`;
}

export function loadingHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset='UTF-8'>
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .sp{width:24px;height:24px;border:3px solid var(--vscode-panel-border);border-top-color:var(--vscode-progressBar-background);border-radius:50%;animation:sp .8s linear infinite;margin-right:10px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .msg{display:flex;align-items:center;color:var(--vscode-descriptionForeground)}
</style></head>
<body><div class='msg'><div class='sp'></div>${esc(t("archive.reading"))}</div></body></html>`;
}

export function contentHtml(
  tree: TreeNode[],
  fileCount: number,
  dirCount: number,
  cssUri: string,
  jsUri: string,
): string {
  const treeHtml = renderTree(tree, 0);
  const emptyMsg = esc(t("decompress.previewTitle") + ": (empty)");

  return `<!DOCTYPE html>
<html><head><meta charset='UTF-8'>
${cssLink(cssUri)}</head>
<body>
${
  fileCount > 0
    ? `<div class='tb'>
    <div class='tb-l'>
      <button class='btn' onclick='extSel()' id='bSel' disabled>${"\u{1F4E6}"} Extract</button>
      <button class='btn' onclick='delSel()' id='bDel' disabled>${"\u{1F5D1}"} Delete</button>
      <span class='sel-cnt'><span id='cnt'>0</span></span>
      <button class='btn-ico' title='Expand All' onclick='expandAll()'>${"\u{1F4C2}"}</button>
      <button class='btn-ico' title='Collapse All' onclick='collapseAll()'>${"\u{1F4C1}"}</button>
    </div>
    <div class='tb-m'>
      <span class='sort-lbl' onclick='doSort("name")' id='sortName'>Name</span>
      <span class='sort-lbl' onclick='doSort("size")' id='sortSize'>Size</span>
      <span id='sortLbl' style='font-size:calc(var(--vscode-font-size)*0.78);color:var(--vscode-descriptionForeground)'></span>
      <input class='srch' type='text' placeholder='Filter\u2026' oninput='doSearch(this.value)'>
      <button class='btn-ico' title='Test Archive' onclick='testArchive()'>${"\u{2705}"}</button>
      <button class='btn-ico' title='Properties' onclick='var p=document.getElementById("props");p.style.display=p.style.display=="none"?"":"none"'>${"\u{2139}"}</button>
      <button class='btn' onclick='extAll()'>${"\u{1F4E6}"} Extract All</button>
    </div>
  </div>
  <div id='props' class='props' style='display:none'></div>
<div class='tree'>${treeHtml}</div>`
    : `<div class='empty'>${emptyMsg}</div>`
}
  <div id='s' class='st'></div>
  ${jsScript(jsUri)}
  <script>var _totFiles=${fileCount},_totDirs=${dirCount};</script>
</body></html>`;
}

export { esc, renderRow, renderTree };
