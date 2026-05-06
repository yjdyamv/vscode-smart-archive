/**
 * Webview message router — Smart Archive VSCode Extension
 *
 * Dispatches 17 message types from the archive webview.
 * Each handler is a separate named function for readability.
 *
 * @module providers/webview/router
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { decompressWith7z, compressWith7z } from "../../engines/js7z-engine";
import { getFullExt, isSplitVolume, COMPRESS_FORMATS, removeVolumeSuffix } from "../../constants";
import { logger } from "../../utils/logger";
import { t, formatCompactSize } from "../../i18n";
import {
  buildTreeRootOnly,
  getDirChildren,
  buildEntryIndex,
  markNoisyDirs,
  countAllStats,
} from "../treeBuilder";
import { contentHtml } from "../htmlRenderer";
import { JS7z, tryCleanupJS7z, fetchFileList } from "../fileListing";
import { streamToVFS } from "../../engines/js7z-helpers";
import { extractSelected } from "../extraction";
import {
  createFolderInArchive,
  deleteFromArchive,
  initAddToArchive,
  previewFileFromArchive,
  renameInArchive,
  testArchive,
  addToArchive,
} from "../archive";
import { setCopiedPaths } from "../copyPaste";
import { validatePassword, sanitizeTargetDir } from "../../utils/security";
import { decompressWithKnownPassword } from "../../commands/decompress";
import { promptVolumeSize } from "../../ui/prompts";
import { handlerStates, type HandlerState } from "./state";
import {
  getNoisyPatterns,
  isReadOnlyExt,
  showErrorWithCopy,
  uniquePath,
  getWebviewUris,
} from "./helpers";
import { setupWebview } from "./setup";
import { saveExpandedPaths } from "./expandedState";

// ── Message type ──

interface WebviewMsg {
  c: string;
  paths?: string[];
  msg?: string;
  flat?: boolean;
  excludes?: string[];
  path?: string;
  dir?: string;
  name?: string;
  pw?: string;
}

// ── Shared helpers ──

function pwInputBox(
  prompt: string,
  validate?: (v: string) => string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const ib = vscode.window.createInputBox();
    let shown = false;
    const eyeBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("eye"),
      tooltip: t("password.show"),
    };
    const eyeOffBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("eye-closed"),
      tooltip: t("password.hide"),
    };
    const clearBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("close"),
      tooltip: t("input.clear"),
    };
    ib.prompt = prompt;
    ib.password = true;
    ib.ignoreFocusOut = true;
    ib.buttons = [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
    if (validate) {
      ib.onDidChangeValue((v) => {
        ib.validationMessage = validate(v) ?? "";
      });
    }
    ib.onDidAccept(() => {
      if (validate && validate(ib.value)) return;
      const val = ib.value;
      ib.hide();
      resolve(val);
    });
    ib.onDidChangeValue(() => {
      if (shown) {
        shown = false;
        ib.password = true;
        ib.buttons = [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
      }
    });
    ib.onDidTriggerButton((b) => {
      if (b === clearBtn) {
        ib.value = "";
      } else if (b === eyeBtn || b === eyeOffBtn) {
        shown = !shown;
        ib.password = !shown;
        ib.buttons = shown
          ? [eyeOffBtn, clearBtn, vscode.QuickInputButtons.Back]
          : [eyeBtn, clearBtn, vscode.QuickInputButtons.Back];
      } else {
        ib.hide();
        resolve(undefined);
      }
    });
    ib.onDidHide(() => resolve(undefined));
    ib.show();
  });
}

async function promptConvertFormat(): Promise<string | undefined> {
  const formats = COMPRESS_FORMATS.filter((f) => f.canCreate);
  const chosen = await vscode.window.showQuickPick(
    formats.map((f) => ({ label: f.label, description: f.description })),
    { placeHolder: t("compress.selectTargetFormat"), ignoreFocusOut: true },
  );
  return chosen?.label;
}

async function convertArchive(
  srcPath: string,
  dstFormat: string,
  dstPath: string,
  password: string,
  volumeSize?: string,
  outputPassword?: string,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sa_cvt_"));
  try {
    await decompressWith7z({ inputPath: srcPath, outputDir: tmp, password }, { report: () => {} });
    if (volumeSize) {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    }
    const entries = fs.readdirSync(tmp).map((e) => ({ fsPath: path.join(tmp, e) }));
    const fmtInfo = COMPRESS_FORMATS.find((f) => f.label === dstFormat);
    await compressWith7z(
      {
        targets: entries.length ? entries : [{ fsPath: tmp }],
        format: fmtInfo ?? {
          label: dstFormat,
          description: "",
          canCreate: true,
          supportsEncryption: false,
        },
        outputPath: dstPath,
        password: outputPassword ?? password,
        level: vscode.workspace
          .getConfiguration("smart-archive")
          .get<number>("defaultCompressionLevel", 5),
        volumeSize,
      },
      { report: () => {} },
    );
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

// ── Message handlers ──

async function handlePassword(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
  cssUri: string,
  jsUri: string,
  codiconCssUri: string,
): Promise<void> {
  if (!msg.pw) return;
  logger.info({ event: "webview.password.attempt" });
  try {
    const pwEntries = await fetchFileList(s.filePath, msg.pw);
    if (pwEntries.length === 0) {
      webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
      return;
    }
    const js7z = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      validatePassword(msg.pw);
      const testPath = streamToVFS(js7z, s.filePath);
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z t: ${c}`)));
        js7z.callMain(["t", `-p${msg.pw}`, testPath]);
      });
    } catch {
      logger.warn({ event: "webview.password.testFailed" }, "Password verification failed");
      webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
      return;
    } finally {
      tryCleanupJS7z(js7z);
    }
    logger.info({ event: "webview.password.ok", count: pwEntries.length });
    s.password = msg.pw;
    s.entries = pwEntries;
    s.entryIndex = buildEntryIndex(pwEntries);
    const pwTree = buildTreeRootOnly(pwEntries, s.archiveName);
    markNoisyDirs(pwTree, getNoisyPatterns());
    const pwStats = countAllStats(pwEntries);
    const ext = getFullExt(s.filePath);
    const pwToast =
      [".deb", ".rpm"].includes(ext) || isSplitVolume(s.filePath)
        ? t("archive.readOnly")
        : undefined;
    webview.html = contentHtml(
      pwTree,
      pwStats.files,
      pwStats.dirs,
      cssUri,
      jsUri,
      codiconCssUri,
      {
        name: s.archiveName,
        format: ext,
        count: pwStats.total,
        size: formatCompactSize(pwStats.totalSize),
      },
      getNoisyPatterns(),
      pwToast,
    );
    if (isSplitVolume(s.filePath)) {
      webview.html = webview.html.replace(
        "</body>",
        `<script>window._xIsSplit=true</script></body>`,
      );
    }
    if ([".7z", ".zip"].includes(ext) && !isSplitVolume(s.filePath)) {
      webview.html = webview.html.replace(
        "</body>",
        `<script>window._xCanSplit=true</script></body>`,
      );
    }
    webview.html = webview.html.replace(
      "</body>",
      `<script>window._xIsEncrypted=true</script></body>`,
    );
  } catch (err) {
    logger.error({ event: "webview.password.error", err });
    webview.postMessage({ c: "pwerr", t: t("password.wrongPassword") });
  }
}

async function handleExtractAll(webview: vscode.Webview, s: HandlerState): Promise<void> {
  logger.info({ event: "webview.extAll", archiveName: s.archiveName });
  try {
    if (s.password) {
      await decompressWithKnownPassword(s.archiveUri, s.password);
    } else {
      await vscode.commands.executeCommand("yjdyamv.smart-archive.decompress", s.archiveUri);
    }
    webview.postMessage({ c: "ok", t: t("decompress.done") + s.archiveName });
  } catch (err) {
    logger.error({ event: "webview.extAll.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  }
}

async function handleExtractSelected(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
): Promise<void> {
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
  logger.info({ event: "webview.extSel", count: msg.paths.length, first: msg.paths[0] });
  if ([".deb", ".rpm"].includes(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  try {
    await extractSelected(s.filePath, msg.paths, s.password, msg.flat, undefined, msg.excludes);
    webview.postMessage({ c: "ok", t: t("decompress.done") + s.archiveName });
  } catch (err) {
    logger.error({ event: "webview.extSel.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  }
}

function handleCopy(webview: vscode.Webview, s: HandlerState, msg: WebviewMsg): void {
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
  setCopiedPaths(msg.paths, s.filePath, s.password, msg.flat);
  logger.info({ event: "webview.copy", count: msg.paths.length, flat: msg.flat });
  vscode.window.showInformationMessage(t("archive.copied", String(msg.paths.length)));
  vscode.commands.executeCommand("yjdyamv.smart-archive.paste");
}

async function handleDelete(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
): Promise<void> {
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  logger.info({ event: "webview.delSel", count: msg.paths.length, first: msg.paths[0] });

  const confirm = await vscode.window.showWarningMessage(
    t("archive.deletingProgress", String(msg.paths.length)),
    { modal: true },
    t("delete.confirm"),
  );
  if (confirm !== t("delete.confirm")) {
    webview.postMessage({ c: "loading", t: false });
    return;
  }

  try {
    webview.postMessage({ c: "loading", t: t("archive.deleting") });
    await deleteFromArchive(s.filePath, msg.paths, s.password);
    try {
      await setupWebview(
        webview,
        s.archiveUri,
        t("archive.toastDeleted", String(msg.paths.length)),
      );
    } catch {}
  } catch (err) {
    logger.error({ event: "webview.delSel.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleRename(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
): Promise<void> {
  if (typeof msg.path !== "string") return;
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  const oldPath = msg.path;
  const oldName = path.basename(oldPath);
  const newName = await vscode.window.showInputBox({
    prompt: "Rename to",
    value: oldName,
    validateInput: (v) =>
      !v.trim()
        ? "Name cannot be empty"
        : v.includes("\0")
          ? "Invalid character"
          : /[<>:"/\\|?*]/.test(v)
            ? 'Invalid characters: < > : " / \\ | ? *'
            : v.trim() === oldName
              ? "New name is the same as current"
              : v.length > 255
                ? "Name too long"
                : null,
  });
  if (!newName || !newName.trim() || newName.trim() === oldName) {
    logger.info({ event: "webview.rename.cancelled", oldPath });
    return;
  }
  const parentDir = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/") + 1) : "";
  const newPath = parentDir + newName.trim();
  logger.info({ event: "webview.rename", oldPath, newPath });
  try {
    webview.postMessage({ c: "loading", t: "Renaming..." });
    await renameInArchive(s.filePath, oldPath, newPath, s.password);
    if (s.archiveUri) {
      try {
        await setupWebview(webview, s.archiveUri, t("archive.toastRenamed"));
      } catch {}
    }
  } catch (err) {
    logger.error({ event: "webview.rename.failed", err }, (err as Error).message);
    showErrorWithCopy(t("decompress.failed") + (err as Error).message);
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleAddFiles(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
): Promise<void> {
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  let targetAddDir: string;
  try {
    targetAddDir = sanitizeTargetDir(typeof msg.dir === "string" ? msg.dir : "");
  } catch (err) {
    webview.postMessage({ c: "err", t: (err as Error).message });
    return;
  }
  logger.info({ event: "webview.addFiles", dir: targetAddDir });
  initAddToArchive(s.filePath, targetAddDir, s.password, webview, s.archiveUri, setupWebview);
  vscode.commands.executeCommand("yjdyamv.smart-archive.addToArchive");
}

async function handleDropFiles(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
): Promise<void> {
  if (!Array.isArray(msg.paths) || msg.paths.length === 0) return;
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  let targetDir: string;
  try {
    targetDir = sanitizeTargetDir(typeof msg.dir === "string" ? msg.dir : "");
  } catch (err) {
    webview.postMessage({ c: "err", t: (err as Error).message });
    return;
  }
  logger.info({
    event: "webview.dropFiles",
    count: msg.paths.length,
    dir: targetDir,
    first: msg.paths[0],
  });
  try {
    webview.postMessage({ c: "loading", t: "Adding files..." });
    await addToArchive(s.filePath, msg.paths, targetDir, s.password);
    try {
      await setupWebview(webview, s.archiveUri, t("archive.toastAddedFiles"));
    } catch {}
  } catch (err) {
    logger.error({ event: "webview.dropFiles.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleNewFolder(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
): Promise<void> {
  if (isReadOnlyExt(getFullExt(s.filePath))) {
    webview.postMessage({ c: "err", t: t("archive.readOnly") });
    return;
  }
  let targetDir: string;
  try {
    targetDir = sanitizeTargetDir(typeof msg.dir === "string" ? msg.dir : "");
  } catch (err) {
    webview.postMessage({ c: "err", t: (err as Error).message });
    return;
  }
  const folderName = await vscode.window.showInputBox({
    prompt: "Folder name",
    placeHolder: "new-folder",
    validateInput: (v) =>
      !v.trim()
        ? "Folder name cannot be empty"
        : v.includes("\0")
          ? "Invalid character"
          : /[<>:"/\\|?*]/.test(v)
            ? 'Invalid characters: < > : " / \\ | ? *'
            : v.length > 255
              ? "Name too long"
              : null,
  });
  if (!folderName || !folderName.trim()) {
    logger.info({ event: "webview.newFolder.cancelled" });
    webview.postMessage({ c: "loading", t: false });
    return;
  }
  const name = folderName.trim();
  logger.info({ event: "webview.newFolder", dir: targetDir, name });
  try {
    webview.postMessage({ c: "loading", t: "Creating folder..." });
    await createFolderInArchive(s.filePath, targetDir, name, s.password);
    if (s.archiveUri) {
      try {
        await setupWebview(webview, s.archiveUri, t("archive.toastCreatedFolder"));
      } catch {}
    }
  } catch (err) {
    logger.error({ event: "webview.newFolder.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handlePreview(
  webview: vscode.Webview,
  s: HandlerState,
  msg: WebviewMsg,
): Promise<void> {
  if (typeof msg.path !== "string") return;
  logger.info({ event: "webview.preview", path: msg.path });
  try {
    await previewFileFromArchive(s.filePath, msg.path, s.password);
  } catch (err) {
    logger.error({ event: "webview.preview.failed", err }, (err as Error).message);
    showErrorWithCopy(t("decompress.failed") + (err as Error).message);
  }
}

async function handleConvert(webview: vscode.Webview, s: HandlerState): Promise<void> {
  logger.info({ event: "webview.convert", path: s.filePath });
  try {
    const fmt = await promptConvertFormat();
    if (!fmt) return;
    const oldExt = getFullExt(s.filePath);
    const dst = s.filePath.slice(0, -oldExt.length) + `.${fmt}`;
    webview.postMessage({ c: "loading", t: "Converting..." });
    await convertArchive(s.filePath, fmt, dst, s.password ?? "");
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
  } catch (err) {
    logger.error({ event: "webview.convert.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleMerge(webview: vscode.Webview, s: HandlerState): Promise<void> {
  logger.info({ event: "webview.merge", path: s.filePath });
  try {
    const ext = getFullExt(s.filePath);
    const fmt = ext.slice(1);
    const dst = removeVolumeSuffix(s.filePath);
    webview.postMessage({ c: "loading", t: "Merging volumes..." });
    await convertArchive(s.filePath, fmt, dst, s.password ?? "");
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
  } catch (err) {
    logger.error({ event: "webview.merge.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleSplit(webview: vscode.Webview, s: HandlerState): Promise<void> {
  logger.info({ event: "webview.split", path: s.filePath });
  try {
    const volSize = await promptVolumeSize();
    if (!volSize) return;
    const ext = getFullExt(s.filePath);
    const fmt = ext.slice(1);
    const dir = path.dirname(s.filePath);
    const base = path.basename(s.filePath);
    const folderName = base.replace(/\.[^.]+$/, "");
    let folderPath = path.join(dir, folderName);
    if (fs.existsSync(folderPath)) {
      let i = 1;
      while (fs.existsSync(path.join(dir, `${folderName}_${i}`))) i++;
      folderPath = path.join(dir, `${folderName}_${i}`);
    }
    const dst = path.join(folderPath, base);
    webview.postMessage({ c: "loading", t: "Splitting..." });
    await convertArchive(s.filePath, fmt, dst, s.password ?? "", volSize);
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${folderPath}` });
  } catch (err) {
    logger.error({ event: "webview.split.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleEncrypt(webview: vscode.Webview, s: HandlerState): Promise<void> {
  logger.info({ event: "webview.encrypt", path: s.filePath });
  try {
    const newPw = await pwInputBox("Enter a password to encrypt this archive", (v) =>
      v ? undefined : "Password is required",
    );
    if (!newPw) return;
    const confirmPw = await pwInputBox("Confirm encryption password");
    if (!confirmPw) return;
    if (confirmPw !== newPw) {
      vscode.window.showErrorMessage("Passwords do not match");
      return;
    }
    const ext = getFullExt(s.filePath);
    const fmt = ext.slice(1);
    let volSize: string | undefined;
    let dst: string;
    if (isSplitVolume(s.filePath)) {
      volSize = await promptVolumeSize();
      if (!volSize) return;
      const base = removeVolumeSuffix(s.filePath);
      const baseName = path.basename(base, ext);
      const dir = path.dirname(s.filePath);
      let folder = path.join(dir, baseName + "_encrypted");
      if (fs.existsSync(folder)) {
        let i = 1;
        while (fs.existsSync(path.join(dir, `${baseName}_encrypted_${i}`))) i++;
        folder = path.join(dir, `${baseName}_encrypted_${i}`);
      }
      dst = path.join(folder, path.basename(base));
    } else {
      dst = uniquePath(s.filePath.slice(0, -ext.length) + "_encrypted" + ext);
    }
    webview.postMessage({ c: "loading", t: "Encrypting..." });
    await convertArchive(s.filePath, fmt, dst, s.password ?? "", volSize, newPw);
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
    webview.postMessage({ c: "encState", v: true });
  } catch (err) {
    logger.error({ event: "webview.encrypt.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleDecrypt(webview: vscode.Webview, s: HandlerState): Promise<void> {
  logger.info({ event: "webview.decrypt", path: s.filePath });
  try {
    let pw = s.password;
    if (!pw) {
      pw = await pwInputBox("Enter the archive password to decrypt");
      if (!pw) return;
    }
    const ext = getFullExt(s.filePath);
    const fmt = ext.slice(1);
    let volSize: string | undefined;
    let dst: string;
    if (isSplitVolume(s.filePath)) {
      volSize = await promptVolumeSize();
      if (!volSize) return;
      const base = removeVolumeSuffix(s.filePath);
      const baseName = path.basename(base, ext);
      const dir = path.dirname(s.filePath);
      let folder = path.join(dir, baseName + "_decrypted");
      if (fs.existsSync(folder)) {
        let i = 1;
        while (fs.existsSync(path.join(dir, `${baseName}_decrypted_${i}`))) i++;
        folder = path.join(dir, `${baseName}_decrypted_${i}`);
      }
      dst = path.join(folder, path.basename(base));
    } else {
      dst = uniquePath(s.filePath.slice(0, -ext.length) + "_decrypted" + ext);
    }
    webview.postMessage({ c: "loading", t: "Decrypting..." });
    await convertArchive(s.filePath, fmt, dst, pw, volSize, "");
    webview.postMessage({ c: "ok", t: `${t("compress.done")}${dst}` });
    webview.postMessage({ c: "encState", v: false });
  } catch (err) {
    logger.error({ event: "webview.decrypt.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  } finally {
    webview.postMessage({ c: "loading", t: false });
  }
}

async function handleTest(webview: vscode.Webview, s: HandlerState): Promise<void> {
  logger.info({ event: "webview.test", path: s.filePath });
  try {
    const result = await testArchive(s.filePath, s.password);
    webview.postMessage({ c: "ok", t: result });
  } catch (err) {
    logger.error({ event: "webview.test.failed", err }, (err as Error).message);
    webview.postMessage({ c: "err", t: t("decompress.failed") + (err as Error).message });
  }
}

// ── Dispatcher ──

export function registerHandler(webview: vscode.Webview): void {
  webview.onDidReceiveMessage((msg: WebviewMsg) => {
    (async () => {
      logger.info({ event: "webview.msg", c: msg.c, dir: msg.dir });
      const s = handlerStates.get(webview);
      if (!s) return;

      if (msg.c === "log") {
        logger.debug({ event: "webview.ui", msg: msg.msg });
        return;
      }

      if (msg.c === "expandDir" && typeof msg.path === "string") {
        const children = getDirChildren(msg.path, s.entries, s.entryIndex);
        markNoisyDirs(children, getNoisyPatterns());
        webview.postMessage({ c: "dirChildren", path: msg.path, children });
        return;
      }

      if (msg.c === "saveExpanded" && Array.isArray(msg.paths)) {
        saveExpandedPaths(s.archiveUri, msg.paths);
        return;
      }

      const { cssUri, jsUri, codiconCssUri } = getWebviewUris(webview);

      if (msg.c === "pw") {
        await handlePassword(webview, s, msg, cssUri, jsUri, codiconCssUri);
        return;
      }

      switch (msg.c) {
        case "extAll":
          await handleExtractAll(webview, s);
          break;
        case "extSel":
          await handleExtractSelected(webview, s, msg);
          break;
        case "copy":
          handleCopy(webview, s, msg);
          break;
        case "delSel":
          await handleDelete(webview, s, msg);
          break;
        case "renamePrompt":
          await handleRename(webview, s, msg);
          break;
        case "addFiles":
          await handleAddFiles(webview, s, msg);
          break;
        case "dropFiles":
          await handleDropFiles(webview, s, msg);
          break;
        case "newFolderPrompt":
          await handleNewFolder(webview, s, msg);
          break;
        case "preview":
          await handlePreview(webview, s, msg);
          break;
        case "merge":
          await handleMerge(webview, s);
          break;
        case "split":
          await handleSplit(webview, s);
          break;
        case "convert":
          await handleConvert(webview, s);
          break;
        case "encrypt":
          await handleEncrypt(webview, s);
          break;
        case "decrypt":
          await handleDecrypt(webview, s);
          break;
        case "test":
          await handleTest(webview, s);
          break;
      }
    })().catch((err) => {
      logger.error({ event: "webview.msg.unhandled", err }, "Unhandled webview message error");
    });
  });
}
