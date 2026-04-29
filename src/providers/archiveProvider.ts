/**
 * Archive Provider — custom readonly editor for archive files (.7z, .zip, .rar, …).
 * Opens as the default editor in VSCode's editor area with an explorer-style tree,
 * checkbox selection, and extract buttons.
 *
 * @module providers/archiveProvider
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { listFiles } from "../engines/js7z-engine";
import { getFileList, extractSelectedFiles } from "../engines/libarchive-engine";
import { t, formatCompactSize } from "../i18n";
import { getOutputPath, copyDirFromFS } from "../utils/fs";
import { isRarExt, getFullExt, isWrappedFormat } from "../constants";

// ── Tree ───────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  size: number;
  kind: string;
  children?: TreeNode[];
}

function buildTree(
  entries: { path: string; size: number; type: string }[],
  archiveName: string,
): TreeNode[] {
  const filtered = entries.filter((e) => {
    const segs = e.path.replace(/\\/g, "/").split("/").filter(Boolean);
    return segs[segs.length - 1] !== archiveName;
  });
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const sorted = [...filtered].sort((a, b) => {
    const aD = a.type !== "REGULAR_FILE" ? 0 : 1;
    const bD = b.type !== "REGULAR_FILE" ? 0 : 1;
    if (aD !== bD) return aD - bD;
    return a.path.localeCompare(b.path);
  });

  for (const entry of sorted) {
    const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let siblings = root;
    let prefix = "";

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const last = i === parts.length - 1;
      const full = prefix ? prefix + "/" + seg : seg;

      if (last) {
        const node: TreeNode = {
          name: seg,
          path: entry.path,
          size: entry.size,
          kind: entry.type === "DIRECTORY" ? "DIRECTORY" : "REGULAR_FILE",
          children: entry.type === "DIRECTORY" ? [] : undefined,
        };
        siblings.push(node);
        if (entry.type === "DIRECTORY") dirMap.set(full, node);
      } else {
        let dir = dirMap.get(full);
        if (!dir) {
          dir = { name: seg, path: full, size: 0, kind: "DIRECTORY", children: [] };
          siblings.push(dir);
          dirMap.set(full, dir);
        }
        siblings = dir.children!;
        prefix = full;
      }
    }
  }
  return root;
}

// ── File-type icon ─────────────────────────────────────────────────

const FILE_ICONS: { exts: string[]; color: string; emoji: string }[] = [
  { exts: ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tiff"], color: "#4caf50", emoji: "\u{1F5BC}" },
  { exts: ["ts", "tsx", "js", "jsx", "py", "rb", "rs", "go", "java", "c", "cpp", "h", "swift", "kt", "cs", "php", "r"], color: "#3178c6", emoji: "\u{1F4DD}" },
  { exts: ["css", "scss", "less", "sass"], color: "#42a5f5", emoji: "\u{1F3A8}" },
  { exts: ["html", "htm", "xml", "vue", "svelte"], color: "#e44d26", emoji: "\u{1F310}" },
  { exts: ["json", "yaml", "yml", "toml", "ini", "cfg"], color: "#ffb300", emoji: "\u{1F4CA}" },
  { exts: ["zip", "gz", "bz2", "xz", "7z", "rar", "tar", "zst"], color: "#ff9800", emoji: "\u{1F4E6}" },
  { exts: ["md", "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"], color: "#42a5f5", emoji: "\u{1F4C4}" },
  { exts: ["sh", "bash", "bat", "ps1", "zsh", "fish"], color: "#4eaa25", emoji: "\u{1F4DC}" },
  { exts: ["sql", "db", "sqlite", "sqlite3"], color: "#e65100", emoji: "\u{1F5C4}" },
  { exts: ["exe", "dll", "so", "dylib"], color: "#9e9e9e", emoji: "\u{2699}" },
  { exts: ["lock"], color: "#9e9e9e", emoji: "\u{1F512}" },
  { exts: ["env"], color: "#fbc02d", emoji: "\u{2699}" },
  { exts: ["gitignore"], color: "#f05033", emoji: "\u{1F4DD}" },
  { exts: ["wasm"], color: "#654ff0", emoji: "\u{1F9F1}" },
];

function fileIcon(name: string, isDir: boolean): { color: string; emoji: string } {
  if (isDir) return { color: "#dcb67a", emoji: "\u{1F4C1}" };
  const ext = (name.split(".").pop() || "").toLowerCase();
  for (const row of FILE_ICONS) {
    if (row.exts.includes(ext)) return { color: row.color, emoji: row.emoji };
  }
  return { color: "#9e9e9e", emoji: "\u{1F4C4}" };
}

// ── Escaping ───────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Render ─────────────────────────────────────────────────────────

const INDENT_PX = 16;

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
    `<div class='rw${isDir ? " dir" : ""}' style='padding-left:${depth * INDENT_PX}px' data-path='${esc(node.path)}'` +
    (hasKids ? " onclick='togDir(event,this)'" : "") +
    ">" +
    guides +
    "<span class='cb' onclick='selOne(event)'><span class='ck'></span></span>" +
    `<span class='ar'>${hasKids ? "\u25BC" : isDir ? "\u25B6" : ""}</span>` +
    `<span class='ic' style='color:${color}'>${emoji}</span>` +
    `<span class='nm'>${esc(node.name)}</span>` +
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

// ── CSS (VSCode-variable driven) ───────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);
  background:var(--vscode-sideBar-background)
}
.tb{
  position:sticky;top:0;z-index:1;
  display:flex;align-items:center;justify-content:space-between;
  padding:4px 12px;
  border-bottom:1px solid var(--vscode-sideBarSectionHeader-border);
  background:var(--vscode-sideBarSectionHeader-background)
}
.tb-l{display:flex;align-items:center;gap:8px}
.btn{
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  border:none;padding:2px 10px;border-radius:2px;
  cursor:pointer;font-size:calc(var(--vscode-font-size) * 0.92)
}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn:disabled{opacity:.5;cursor:default}
.sel-cnt{font-size:calc(var(--vscode-font-size) * 0.92);color:var(--vscode-descriptionForeground)}
.sel-cnt span{font-weight:600;color:var(--vscode-foreground)}
.tree{padding:4px 0}
.rw{
  position:relative;
  height:calc(var(--vscode-font-size) * 1.8);
  line-height:calc(var(--vscode-font-size) * 1.8);
  display:flex;align-items:center;
  cursor:default;user-select:none;padding-right:8px
}
.rw:hover{background:var(--vscode-list-hoverBackground)}
.gd{
  position:absolute;top:0;bottom:0;width:1px;
  background:var(--vscode-tree-indentGuidesStroke);
  pointer-events:none
}
.cb{width:20px;flex-shrink:0;text-align:center;cursor:pointer;padding:2px 0}
.cb:hover .ck{border-color:var(--vscode-focusBorder,#007acc);box-shadow:0 0 0 1px var(--vscode-focusBorder,#007acc44)}
.ck{
  display:inline-block;width:calc(var(--vscode-font-size) * 1.3);
  height:calc(var(--vscode-font-size) * 1.3);
  border:1.5px solid var(--vscode-checkbox-border,#6e7681);
  border-radius:3px;background:var(--vscode-checkbox-background,transparent);
  vertical-align:middle;position:relative;transition:all .12s
}
.ck.on{
  background:var(--vscode-checkbox-selectBackground,#0e639c);
  border-color:var(--vscode-checkbox-selectBorder,#007acc)
}
.ck.on::after{
  content:'';position:absolute;left:26%;top:12%;width:30%;height:55%;
  border:solid var(--vscode-checkbox-selectForeground,#2ea043);
  border-width:0 2px 2px 0;transform:rotate(45deg)
}
.ar{width:calc(var(--vscode-font-size) * 1.2);flex-shrink:0;text-align:center;font-size:10px;color:var(--vscode-descriptionForeground)}
.ic{width:calc(var(--vscode-font-size) * 1.2);text-align:center;flex-shrink:0;font-size:calc(var(--vscode-font-size) * 1.1);line-height:calc(var(--vscode-font-size) * 1.8)}
.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sz{
  font-size:calc(var(--vscode-font-size) * 0.85);
  color:var(--vscode-descriptionForeground);
  margin-left:1em;flex-shrink:0
}
.grp{}
.st{margin:8px 12px;padding:4px 10px;border-radius:4px;font-size:calc(var(--vscode-font-size) * 0.92);display:none}
.st.ok{display:block;background:var(--vscode-terminal-ansiGreen);color:var(--vscode-editor-background)}
.st.er{display:block;background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-inputValidation-errorForeground);border:1px solid var(--vscode-inputValidation-errorBorder)}
.empty{text-align:center;color:var(--vscode-descriptionForeground);padding:4em 1.5em;font-size:var(--vscode-font-size)}
`;

// ── HTML ───────────────────────────────────────────────────────────

const JS = `
var v=acquireVsCodeApi();
var sel=new Set();
function updateUI(){var n=sel.size;document.getElementById('cnt').textContent=n;document.getElementById('bSel').disabled=n===0}
function getPath(el){return el.closest('.rw').dataset.path}
function selOne(e){
  e.stopPropagation();
  var r=e.currentTarget.closest('.rw'),p=getPath(r),k=r.querySelector('.ck');
  if(sel.has(p)){
    sel.delete(p);k.classList.remove('on');
    unselKids(r);
  } else {
    sel.add(p);k.classList.add('on');
    selKids(r);
  }
  updateUI()
}
function selKids(el){
  var g=el.nextElementSibling;
  if(!g||!g.classList.contains('grp'))return;
  var rs=g.querySelectorAll('.rw');
  for(var i=0;i<rs.length;i++){
    var p=getPath(rs[i]);
    if(!sel.has(p)){sel.add(p);rs[i].querySelector('.ck').classList.add('on')}
  }
}
function unselKids(el){
  var g=el.nextElementSibling;
  if(!g||!g.classList.contains('grp'))return;
  var rs=g.querySelectorAll('.rw');
  for(var i=0;i<rs.length;i++){
    var p=getPath(rs[i]);
    sel.delete(p);rs[i].querySelector('.ck').classList.remove('on')
  }
}
function extAll(){document.getElementById('s').className='st';v.postMessage({c:'extAll'})}
function extSel(){
  var ps=[...sel];if(!ps.length)return;
  document.getElementById('s').className='st';v.postMessage({c:'extSel',paths:ps})
}
function togDir(e,el){
  e.stopPropagation();
  var nx=el.nextElementSibling;
  if(!nx||!nx.classList.contains('grp'))return;
  var ar=el.querySelector('.ar'),hd=nx.style.display!=='none';
  nx.style.display=hd?'none':'';
  if(ar)ar.textContent=hd?'\u25B6':'\u25BC'
}
window.addEventListener('message',function(e){
  var s=document.getElementById('s');
  if(e.data.c==='ok'){s.className='st ok';s.textContent=e.data.t}
  else if(e.data.c==='err'){s.className='st er';s.textContent=e.data.t}
});
`;

function loadingHtml(): string {
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

function contentHtml(tree: TreeNode[], fileCount: number): string {
  const treeHtml = renderTree(tree, 0);
  const emptyMsg = esc(t("decompress.previewTitle") + ": (empty)");

  return `<!DOCTYPE html>
<html><head><meta charset='UTF-8'>
<style>${CSS}</style></head>
<body>
${
  fileCount > 0
    ? `<div class='tb'>
    <div class='tb-l'>
      <button class='btn' onclick='extSel()' id='bSel' disabled>${"\u{1F4E6}"} Extract Selected</button>
      <span class='sel-cnt'><span id='cnt'>0</span> selected</span>
    </div>
    <button class='btn' onclick='extAll()'>${"\u{1F4E6}"} Extract All</button>
  </div>
<div class='tree'>${treeHtml}</div>`
    : `<div class='empty'>${emptyMsg}</div>`
}
  <div id='s' class='st'></div>
  <script>${JS}</script>
</body></html>`;
}

// ── Data ───────────────────────────────────────────────────────────

async function fetchFileList(
  filePath: string,
): Promise<{ path: string; size: number; type: string }[]> {
  const ext = getFullExt(filePath);
  // Wrapped formats (tar.gz/.tgz etc.): 7z l -slt only sees outer layer.
  // Extract to virtual FS temporarily to discover inner tar file list.
  if (isWrappedFormat(ext)) return listViaExtract(filePath);
  try {
    const f = await listFiles(filePath);
    if (f && f.length > 0) return f;
  } catch {
    /* fallthrough */
  }
  return getFileList(filePath);
}

async function listViaExtract(filePath: string): Promise<{ path: string; size: number; type: string }[]> {
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  const archiveName = path.basename(filePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  js7z.FS.writeFile(`/${archiveName}`, new Uint8Array(data));
  js7z.FS.mkdir("/_ls");
  await new Promise<void>((resolve, reject) => {
    js7z.onExit = (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`7z x: ${code}`));
    };
    js7z.callMain(["x", `/${archiveName}`, "-o/_ls", "-y"]);
  });
  // Check if output contains a single .tar (inner tar not auto-extracted)
  const topEntries = js7z.FS.readdir("/_ls").filter((e: string) => e !== "." && e !== "..");
  if (topEntries.length === 1 && topEntries[0].endsWith(".tar")) {
    const innerTar = topEntries[0];
    // Extract inner tar to /_ls2
    const innerData = js7z.FS.readFile(`/_ls/${innerTar}`, { encoding: "binary" });
    const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
    js7z2.FS.writeFile(`/${innerTar}`, new Uint8Array(innerData));
    js7z2.FS.mkdir("/_ls2");
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`7z x inner tar: ${code}`));
      };
      js7z2.callMain(["x", `/${innerTar}`, "-o/_ls2", "-y"]);
    });
    return readDirEntries(js7z2, "/_ls2", "");
  }
  return readDirEntries(js7z, "/_ls", "");
}

function readDirEntries(
  js7z: any,
  dir: string,
  prefix: string,
): { path: string; size: number; type: string }[] {
  const results: { path: string; size: number; type: string }[] = [];
  const entries = js7z.FS.readdir(dir);
  for (const name of entries) {
    if (name === "." || name === "..") continue;
    const fp = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const childPath = prefix ? `${prefix}/${name}` : name;
    try {
      const st = js7z.FS.stat(fp);
      if (js7z.FS.isDir(st.mode)) {
        results.push({ path: childPath, size: 0, type: "DIRECTORY" });
        results.push(...readDirEntries(js7z, fp, childPath));
      } else {
        results.push({ path: childPath, size: (st as any).size || 0, type: "REGULAR_FILE" });
      }
    } catch {
      results.push({ path: childPath, size: 0, type: "REGULAR_FILE" });
    }
  }
  return results;
}

// ── Extract helpers ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
const JS7z: any = require("js7z-tools");

async function extractSelected(archivePath: string, selectedPaths: string[]): Promise<void> {
  const ext = getFullExt(archivePath);
  const isRar = isRarExt(ext);
  const isWrapped = isWrappedFormat(ext);
  const outputDir = getOutputPath(archivePath, "extracted");

  // RAR: 7z can't extract RAR at all; use libarchive
  if (isRar) {
    fs.mkdirSync(outputDir, { recursive: true });
    const count = await extractSelectedFiles(archivePath, outputDir, selectedPaths);
    vscode.window.showInformationMessage(t("decompress.rarDone", String(count)) + outputDir);
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
    return;
  }

  // Wrapped (tar.gz etc.): 7z x only extracts outer layer.
  // Two-step: extract outer → get inner .tar → extract inner with selected paths.
  if (isWrapped) {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
    const archiveName = path.basename(archivePath);
    const js7z = await JS7z({ print: () => {}, printErr: () => {} });
    js7z.FS.writeFile(`/${archiveName}`, new Uint8Array(data));
    js7z.FS.mkdir("/_x1");
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => { if (c === 0) resolve(); else reject(new Error(`7z x outer: ${c}`)); };
      js7z.callMain(["x", `/${archiveName}`, "-o/_x1", "-y"]);
    });
    const top = js7z.FS.readdir("/_x1").filter((e: string) => e !== "." && e !== "..");
    const innerTar = top.find((e: string) => e.endsWith(".tar"));
    if (!innerTar) throw new Error("Wrapped archive: no inner .tar found");
    const innerData = js7z.FS.readFile(`/_x1/${innerTar}`, { encoding: "binary" });
    const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
    js7z2.FS.writeFile(`/${innerTar}`, new Uint8Array(innerData));
    js7z2.FS.mkdir("/_x2");
    const normalizedPaths = selectedPaths.map((p) => p.replace(/\\/g, "/"));
    await new Promise<void>((resolve, reject) => {
      js7z2.onExit = (c: number) => { if (c === 0) resolve(); else reject(new Error(`7z x inner: ${c}`)); };
      js7z2.callMain(["x", `/${innerTar}`, "-o/_x2", "-y", ...normalizedPaths]);
    });
    copyDirFromFS(js7z2, "/_x2", outputDir);
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
    vscode.window.showInformationMessage(t("decompress.done") + outputDir);
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

  js7z.FS.writeFile(`/${archiveName}`, new Uint8Array(data));
  js7z.FS.mkdir("/out");

  try {
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`7z x: ${code}\n${stderr}`));
      };
      const normalizedPaths = selectedPaths.map((p) => p.replace(/\\/g, "/"));
      js7z.callMain(["x", `/${archiveName}`, "-o/out", "-y", ...normalizedPaths]);
    });
    copyDirFromFS(js7z, "/out", outputDir);
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
    vscode.window.showInformationMessage(t("decompress.done") + outputDir);
  } catch (err) {
    // 7z failed — fall back to libarchive
    try {
      const count = await extractSelectedFiles(archivePath, outputDir, selectedPaths);
      vscode.window.showInformationMessage(
        t("decompress.rarDone", String(count)) + outputDir,
      );
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
    } catch (fallbackErr) {
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        t("decompress.failed") +
          `\n7z: ${(err as Error).message}\nlibarchive: ${(fallbackErr as Error).message}`,
      );
    }
  }
}

// ── Core setup (reused by both custom editor and browse command) ───

async function setupWebview(webview: vscode.Webview, archiveUri: vscode.Uri): Promise<void> {
  const filePath = archiveUri.fsPath;
  const archiveName = path.basename(filePath);

  webview.html = loadingHtml();

  let entries: { path: string; size: number; type: string }[];
  try {
    entries = await fetchFileList(filePath);
  } catch (err) {
    vscode.window.showErrorMessage(t("decompress.failed") + (err as Error).message);
    return;
  }

  const tree = buildTree(entries, archiveName);
  webview.html = contentHtml(tree, entries.length);

  webview.onDidReceiveMessage(async (msg: { c: string; paths?: string[] }) => {
    if (msg.c === "extAll") {
      try {
        await vscode.commands.executeCommand("yjdyamv.smart-archive.decompress", archiveUri);
        webview.postMessage({ c: "ok", t: t("decompress.done") + archiveName });
      } catch (err) {
        webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
      }
    }

    if (msg.c === "extSel" && Array.isArray(msg.paths) && msg.paths.length > 0) {
      try {
        await extractSelected(filePath, msg.paths);
        webview.postMessage({ c: "ok", t: t("decompress.done") + archiveName });
      } catch (err) {
        webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
      }
    }
  });
}

// ── CustomReadonlyEditorProvider ───────────────────────────────────

class ArchiveEditorProvider implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    await setupWebview(webviewPanel.webview, document.uri);
  }
}

export function registerArchiveEditor(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider("archiveViewer", new ArchiveEditorProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Pre-warm libarchive WASM (used in prewarmLibarchive)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prewarmLibarchive } = require("../engines/libarchive-engine") as {
    prewarmLibarchive: () => Promise<void>;
  };
  prewarmLibarchive();
}

// ── Browse command (kept for context-menu access) ──────────────────

export async function openArchivePreview(archiveUri: vscode.Uri): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "archiveViewer",
    t("decompress.previewTitle"),
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  await setupWebview(panel.webview, archiveUri);
}
