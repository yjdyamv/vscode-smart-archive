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
import type { JS7zFactory } from "../types";
import { listFiles, isEncrypted } from "../engines/js7z-engine";
import { getFileList, extractSelectedFiles } from "../engines/libarchive-engine";
import { t, formatCompactSize } from "../i18n";
import { getOutputPath, copyDirFromFS } from "../utils/fs";
import { isRarExt, getFullExt, isWrappedFormat, isEncryptableExt } from "../constants";
import { logger } from "../utils/logger";
import { PREVIEW_CSS } from "../webview/preview.css";
import { PREVIEW_JS } from "../webview/preview.js";

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
  {
    exts: ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tiff"],
    color: "#4caf50",
    emoji: "\u{1F5BC}",
  },
  {
    exts: [
      "ts",
      "tsx",
      "js",
      "jsx",
      "py",
      "rb",
      "rs",
      "go",
      "java",
      "c",
      "cpp",
      "h",
      "swift",
      "kt",
      "cs",
      "php",
      "r",
    ],
    color: "#3178c6",
    emoji: "\u{1F4DD}",
  },
  { exts: ["css", "scss", "less", "sass"], color: "#42a5f5", emoji: "\u{1F3A8}" },
  { exts: ["html", "htm", "xml", "vue", "svelte"], color: "#e44d26", emoji: "\u{1F310}" },
  { exts: ["json", "yaml", "yml", "toml", "ini", "cfg"], color: "#ffb300", emoji: "\u{1F4CA}" },
  {
    exts: ["zip", "gz", "bz2", "xz", "7z", "rar", "tar", "zst"],
    color: "#ff9800",
    emoji: "\u{1F4E6}",
  },
  {
    exts: ["md", "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"],
    color: "#42a5f5",
    emoji: "\u{1F4C4}",
  },
  { exts: ["sh", "bash", "bat", "ps1", "zsh", "fish"], color: "#4eaa25", emoji: "\u{1F4DC}" },
  { exts: ["sql", "db", "sqlite", "sqlite3"], color: "#e65100", emoji: "\u{1F5C4}" },
  { exts: ["exe", "dll", "so", "dylib"], color: "#9e9e9e", emoji: "\u{2699}" },
  { exts: ["lock"], color: "#9e9e9e", emoji: "\u{1F512}" },
  { exts: ["env"], color: "#fbc02d", emoji: "\u{2699}" },
  { exts: ["gitignore"], color: "#f05033", emoji: "\u{1F4DD}" },
  { exts: ["wasm"], color: "#654ff0", emoji: "\u{1F9F1}" },
];

const EXT_ICON_MAP: Record<string, { color: string; emoji: string }> = {};
for (const row of FILE_ICONS) {
  for (const e of row.exts) {
    EXT_ICON_MAP[e] = { color: row.color, emoji: row.emoji };
  }
}

function fileIcon(name: string, isDir: boolean): { color: string; emoji: string } {
  if (isDir) return { color: "#dcb67a", emoji: "\u{1F4C1}" };
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_ICON_MAP[ext] ?? { color: "#9e9e9e", emoji: "\u{1F4C4}" };
}

// ── Escaping ───────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// ── CSS & JS (imported from webview/) ─────────────────────────────

const CSS = PREVIEW_CSS;
const JS = PREVIEW_JS;

function emptyHtml(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset='UTF-8'>
<style>${CSS}</style></head>
<body><div class='empty'>${esc(msg)}</div>
<script>${JS}</script></body></html>`;
}

function passwordHtml(archiveName: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset='UTF-8'>
<style>${CSS}
.pw-box{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:10px}
.pw-inp{position:relative;display:flex;align-items:center}
.pw-inp input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px 36px 6px 12px;border-radius:3px;font-size:var(--vscode-font-size);width:248px;transition:border-color .2s}
.pw-inp input.err{border-color:var(--vscode-inputValidation-errorBorder,#e51400);box-shadow:0 0 0 1px var(--vscode-inputValidation-errorBorder,#e5140033)}
.pw-inp input:focus{outline:1px solid var(--vscode-focusBorder)}
.pw-eye,.pw-clr{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:14px;padding:2px 4px;line-height:1}
.pw-clr{right:28px}
.pw-eye:hover,.pw-clr:hover{color:var(--vscode-foreground)}
.pw-err{color:var(--vscode-inputValidation-errorForeground,#f14c4c);font-size:calc(var(--vscode-font-size) * 0.92);min-height:1.4em;opacity:0;transition:opacity .2s}
.pw-err.on{opacity:1}
</style></head>
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
      <span class='sel-cnt'><span id='cnt'>0</span> selected / <span id='tot'>${fileCount}</span> files</span>
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
  password = "",
): Promise<{ path: string; size: number; type: string }[]> {
  const ext = getFullExt(filePath);
  if (isWrappedFormat(ext)) return listViaExtract(filePath, password);
  try {
    const f = await listFiles(filePath, password);
    if (f && f.length > 0) return f;
  } catch {
    /* encrypted or unsupported — caller handles */
  }
  // For encryptable formats without a password, don't fall back to libarchive —
  // it may leak file structure metadata without requiring the password.
  // Instead return empty to trigger the encryption check / password prompt.
  if (!password && isEncryptableExt(ext)) return [];
  return getFileList(filePath);
}

async function listViaExtract(
  filePath: string,
  password = "",
): Promise<{ path: string; size: number; type: string }[]> {
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  const archiveName = path.basename(filePath);
  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  js7z.FS.writeFile(`/${archiveName}`, new Uint8Array(data));
  js7z.FS.mkdir("/_ls");
  const args = ["x", `/${archiveName}`, "-o/_ls", "-y"];
  if (password) args.splice(1, 0, `-p${password}`);
  await new Promise<void>((resolve, reject) => {
    js7z.onExit = (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`7z x: ${code}`));
    };
    js7z.callMain(args);
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z: JS7zFactory = require("js7z-tools");

async function extractSelected(archivePath: string, selectedPaths: string[]): Promise<void> {
  const ext = getFullExt(archivePath);
  const isRar = isRarExt(ext);
  const isWrapped = isWrappedFormat(ext);
  const outputDir = getOutputPath(archivePath, "extracted");

  // RAR: 7z can't extract RAR at all; use libarchive
  if (isRar) {
    fs.mkdirSync(outputDir, { recursive: true });
    const count = await extractSelectedFiles(
      archivePath,
      outputDir,
      selectedPaths,
      archivePassword || undefined,
    );
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
      js7z.onExit = (c: number) => {
        if (c === 0) resolve();
        else reject(new Error(`7z x outer: ${c}`));
      };
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
      js7z2.onExit = (c: number) => {
        if (c === 0) resolve();
        else reject(new Error(`7z x inner: ${c}`));
      };
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
      const xArgs = ["x", `/${archiveName}`, "-o/out", "-y"];
      if (archivePassword) xArgs.splice(1, 0, `-p${archivePassword}`);
      xArgs.push(...normalizedPaths);
      js7z.callMain(xArgs);
    });
    copyDirFromFS(js7z, "/out", outputDir);
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
    vscode.window.showInformationMessage(t("decompress.done") + outputDir);
  } catch (err) {
    // 7z failed — fall back to libarchive
    try {
      const count = await extractSelectedFiles(archivePath, outputDir, selectedPaths);
      vscode.window.showInformationMessage(t("decompress.rarDone", String(count)) + outputDir);
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
  logger.info({
    event: "setupWebview.start",
    filePath,
    wrapped: isWrappedFormat(getFullExt(filePath)),
  });

  webview.html = loadingHtml();

  let entries: { path: string; size: number; type: string }[];
  try {
    entries = await fetchFileList(filePath);
  } catch (err) {
    logger.error({ event: "setupWebview.fetchFileList.failed", err }, (err as Error).message);
    webview.html = emptyHtml(t("decompress.failed") + (err as Error).message);
    return;
  }

  // Encrypted archive — show password dialog inline
  if (entries.length === 0 && isEncryptableExt(getFullExt(filePath))) {
    let encrypted = false;
    try {
      encrypted = await isEncrypted(filePath);
    } catch {
      /* can't detect */
    }
    if (encrypted) {
      webview.html = passwordHtml(archiveName);
      webview.onDidReceiveMessage(
        async (msg: { c: string; pw?: string; paths?: string[]; msg?: string }) => {
          if (msg.c === "log") {
            logger.debug({ event: "webview.ui", msg: msg.msg });
            return;
          }
          if (msg.c === "pw" && msg.pw) {
            logger.info({ event: "setupWebview.password.attempt" });
            try {
              const pwEntries = await fetchFileList(filePath, msg.pw);
              if (pwEntries.length === 0) {
                logger.warn({ event: "setupWebview.password.failed", reason: "empty" });
                webview.postMessage({ c: "pwerr", t: "Wrong password" });
                return;
              }
              const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
              const js7z = await JS7z({ print: () => {}, printErr: () => {} });
              js7z.FS.writeFile("/_pwtest", new Uint8Array(data));
              try {
                await new Promise<void>((resolve, reject) => {
                  js7z.onExit = (c: number) =>
                    c === 0 ? resolve() : reject(new Error(`7z t: ${c}`));
                  js7z.callMain(["t", `-p${msg.pw}`, "/_pwtest"]);
                });
              } catch {
                logger.warn({ event: "setupWebview.password.failed", reason: "7z t" });
                webview.postMessage({ c: "pwerr", t: "Wrong password" });
                return;
              }
              logger.info({ event: "setupWebview.password.ok", count: pwEntries.length });
              archivePassword = msg.pw;
              const tree = buildTree(pwEntries, archiveName);
              webview.html = contentHtml(tree, pwEntries.length);
              setupExtractHandlers(webview, archiveUri, archiveName, filePath);
            } catch (err) {
              logger.error({ event: "setupWebview.password.error", err });
              webview.postMessage({ c: "pwerr", t: "Wrong password" });
            }
          }
        },
      );
      return;
    }
  }

  logger.info({ event: "setupWebview.entries", count: entries.length });

  const tree = buildTree(entries, archiveName);
  webview.html = contentHtml(tree, entries.length);

  setupExtractHandlers(webview, archiveUri, archiveName, filePath);
}

// Store password for encrypted archives so extract can use it
let archivePassword = "";

function setupExtractHandlers(
  webview: vscode.Webview,
  archiveUri: vscode.Uri,
  archiveName: string,
  filePath: string,
): void {
  webview.onDidReceiveMessage(async (msg: { c: string; paths?: string[]; msg?: string }) => {
    if (msg.c === "log") {
      logger.debug({ event: "webview.ui", msg: msg.msg });
      return;
    }
    if (msg.c === "extAll") {
      logger.info({ event: "webview.extAll", archiveName });
      try {
        await vscode.commands.executeCommand("yjdyamv.smart-archive.decompress", archiveUri);
        webview.postMessage({ c: "ok", t: t("decompress.done") + archiveName });
      } catch (err) {
        logger.error({ event: "webview.extAll.failed", err }, (err as Error).message);
        webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
      }
    }

    if (msg.c === "extSel" && Array.isArray(msg.paths) && msg.paths.length > 0) {
      logger.info({ event: "webview.extSel", count: msg.paths.length, first: msg.paths[0] });
      try {
        await extractSelected(filePath, msg.paths);
        webview.postMessage({ c: "ok", t: t("decompress.done") + archiveName });
      } catch (err) {
        logger.error({ event: "webview.extSel.failed", err }, (err as Error).message);
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
