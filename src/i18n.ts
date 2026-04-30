/**
 * Internationalization (i18n) helper — 7z VSCode Extension
 *
 * Detects VSCode display language and returns UI strings in the appropriate locale.
 * Currently supports English (default) and Chinese (zh-cn, zh-tw).
 *
 * Usage:
 *   import { t } from '../i18n';
 *   const msg = t('compress.title');  // → 'Compressing...' or '正在压缩...'
 *
 * @module i18n
 */

import * as vscode from "vscode";

/** Supported locale codes */
type Locale = "en" | "zh-cn" | "zh-tw";

/** UI string dictionary: key → { en, zh-cn, zh-tw } */
const messages: Record<string, Record<Locale, string>> = {
  // ---- Compress flow ----
  "compress.noFiles": {
    en: "No files selected.",
    "zh-cn": "未选择任何文件。",
    "zh-tw": "未選取任何檔案。",
  },
  "compress.selectFormat": {
    en: "Select archive format",
    "zh-cn": "选择压缩格式",
    "zh-tw": "選取壓縮格式",
  },
  "compress.rarUnsupported": {
    en: "RAR creation is not supported by free/open-source tools.\nConsider using 7z or ZIP format for compression.\nRAR extraction (decompression) is fully supported via libarchive.",
    "zh-cn":
      "RAR 格式创建不受免费/开源工具支持。\n建议使用 7z 或 ZIP 格式进行压缩。\nRAR 解压功能已完整支持（通过 libarchive）。",
    "zh-tw":
      "RAR 格式建立不受免費/開源工具支援。\n建議使用 7z 或 ZIP 格式進行壓縮。\nRAR 解壓功能已完整支援（透過 libarchive）。",
  },
  "compress.progressTitle": {
    en: "Compressing...",
    "zh-cn": "正在压缩...",
    "zh-tw": "正在壓縮...",
  },
  "compress.done": {
    en: "Compressed to: ",
    "zh-cn": "压缩完成: ",
    "zh-tw": "壓縮完成: ",
  },
  "compress.failed": {
    en: "Compression failed: ",
    "zh-cn": "压缩失败: ",
    "zh-tw": "壓縮失敗: ",
  },
  "compress.initEngine": {
    en: "Initializing 7-Zip engine...",
    "zh-cn": "正在初始化 7-Zip 引擎...",
    "zh-tw": "正在初始化 7-Zip 引擎...",
  },
  "compress.readingFiles": {
    en: "Reading files...",
    "zh-cn": "正在读取文件...",
    "zh-tw": "正在讀取檔案...",
  },
  "compress.addedItems": {
    en: "Added {0} item(s)",
    "zh-cn": "已添加 {0} 个项目",
    "zh-tw": "已新增 {0} 個項目",
  },
  "compress.inProgress": {
    en: "Compressing...",
    "zh-cn": "正在压缩...",
    "zh-tw": "正在壓縮...",
  },
  "compress.exitError": {
    en: "7z exited abnormally (code {0})",
    "zh-cn": "7z 异常退出 (代码 {0})",
    "zh-tw": "7z 異常退出 (代碼 {0})",
  },
  "compress.creatingTar": {
    en: "Creating TAR...",
    "zh-cn": "正在创建 TAR...",
    "zh-tw": "正在建立 TAR...",
  },
  "compress.compressingTar": {
    en: "Compressing TAR to {0}...",
    "zh-cn": "正在将 TAR 压缩为 {0}...",
    "zh-tw": "正在將 TAR 壓縮為 {0}...",
  },
  "compress.selectLevel": {
    en: "Select compression level",
    "zh-cn": "选择压缩级别",
    "zh-tw": "選取壓縮級別",
  },

  // ---- Encrypt flow ----
  "encrypt.title": {
    en: "Encrypt archive with AES-256?",
    "zh-cn": "是否使用 AES-256 加密？",
    "zh-tw": "是否使用 AES-256 加密？",
  },
  "encrypt.no": {
    en: "No encryption",
    "zh-cn": "不加密",
    "zh-tw": "不加密",
  },
  "encrypt.yes": {
    en: "Encrypt with AES-256",
    "zh-cn": "使用 AES-256 加密保护内容",
    "zh-tw": "使用 AES-256 加密保護內容",
  },
  "encrypt.setPassword": {
    en: "Set encryption password",
    "zh-cn": "设置加密密码",
    "zh-tw": "設定加密密碼",
  },
  "encrypt.noPassword": {
    en: "No password entered. Skipping encryption.",
    "zh-cn": "未输入密码，将跳过加密。",
    "zh-tw": "未輸入密碼，將跳過加密。",
  },

  // ---- Decompress flow ----
  "decompress.noFile": {
    en: "No archive file selected.",
    "zh-cn": "未选择归档文件。",
    "zh-tw": "未選取封存檔案。",
  },
  "decompress.unknownFormat": {
    en: 'File type "{0}" is not in the known supported list. Proceeding anyway...',
    "zh-cn": '文件类型 "{0}" 不在已知支持列表中。将继续尝试解压...',
    "zh-tw": '檔案類型 "{0}" 不在已知支援列表中。將繼續嘗試解壓...',
  },
  "decompress.progressTitle": {
    en: "Decompressing...",
    "zh-cn": "正在解压...",
    "zh-tw": "正在解壓...",
  },
  "decompress.rarProgressTitle": {
    en: "Decompressing RAR with libarchive...",
    "zh-cn": "正在用 libarchive 解压 RAR...",
    "zh-tw": "正在用 libarchive 解壓 RAR...",
  },
  "decompress.rarExtracting": {
    en: "Extracting RAR archive...",
    "zh-cn": "正在提取 RAR 归档...",
    "zh-tw": "正在擷取 RAR 封存...",
  },
  "decompress.rarDone": {
    en: "Decompressed {0} file(s) to: ",
    "zh-cn": "解压完成: {0} 个文件 → ",
    "zh-tw": "解壓完成: {0} 個檔案 → ",
  },
  "decompress.rarFailed": {
    en: "RAR extraction failed: ",
    "zh-cn": "RAR 解压失败: ",
    "zh-tw": "RAR 解壓失敗: ",
  },
  "decompress.done": {
    en: "Decompressed to: ",
    "zh-cn": "解压完成: ",
    "zh-tw": "解壓完成: ",
  },
  "decompress.failed": {
    en: "Decompression failed: ",
    "zh-cn": "解压失败: ",
    "zh-tw": "解壓失敗: ",
  },
  "decompress.initEngine": {
    en: "Initializing 7-Zip engine...",
    "zh-cn": "正在初始化 7-Zip 引擎...",
    "zh-tw": "正在初始化 7-Zip 引擎...",
  },
  "decompress.inProgress": {
    en: "Decompressing...",
    "zh-cn": "正在解压...",
    "zh-tw": "正在解壓...",
  },
  "decompress.exitError": {
    en: "7z exited abnormally (code {0})",
    "zh-cn": "7z 异常退出 (代码 {0})",
    "zh-tw": "7z 異常退出 (代碼 {0})",
  },

  "decompress.unwrapTar": {
    en: "Unwrapping inner TAR...",
    "zh-cn": "正在解包内层 TAR...",
    "zh-tw": "正在解包內層 TAR...",
  },
  "decompress.fallbackTo7z": {
    en: "libarchive failed, trying 7z...",
    "zh-cn": "libarchive 失败，尝试 7z...",
    "zh-tw": "libarchive 失敗，嘗試 7z...",
  },
  "decompress.fallbackToLA": {
    en: "7z failed, trying libarchive...",
    "zh-cn": "7z 失败，尝试 libarchive...",
    "zh-tw": "7z 失敗，嘗試 libarchive...",
  },
  "decompress.previewTitle": {
    en: "Archive contents",
    "zh-cn": "归档文件内容",
    "zh-tw": "封存檔案內容",
  },
  "decompress.previewEntry": {
    en: "{0} ({1})",
    "zh-cn": "{0}（{1}）",
    "zh-tw": "{0}（{1}）",
  },
  "archive.reading": {
    en: "Reading archive...",
    "zh-cn": "正在读取归档文件...",
    "zh-tw": "正在讀取封存檔案...",
  },
  "archive.parsing": {
    en: "Parsing archive structure...",
    "zh-cn": "正在解析归档结构...",
    "zh-tw": "正在解析封存結構...",
  },
  "archive.extracting": {
    en: "Extracting files...",
    "zh-cn": "正在解压文件...",
    "zh-tw": "正在解壓檔案...",
  },
  "archive.writingFiles": {
    en: "Writing {0} file(s)...",
    "zh-cn": "正在写入 {0} 个文件...",
    "zh-tw": "正在寫入 {0} 個檔案...",
  },

  // ---- Save dialog ----
  "save.filterName": {
    en: "Archive Files",
    "zh-cn": "归档文件",
    "zh-tw": "封存檔案",
  },

  // ---- Generic ----
  "fs.copyFailed": {
    en: "Failed to copy: ",
    "zh-cn": "复制失败: ",
    "zh-tw": "複製失敗: ",
  },

  // ---- Extension lifecycle ----
  "extension.activated": {
    en: "[7z] Extension activated",
    "zh-cn": "[7z] 扩展已激活",
    "zh-tw": "[7z] 擴充功能已啟用",
  },
  "extension.deactivated": {
    en: "[7z] Extension deactivated",
    "zh-cn": "[7z] 扩展已停用",
    "zh-tw": "[7z] 擴充功能已停用",
  },

  // ---- Password prompt ----
  "password.decryptHint": {
    en: "Decryption password (leave blank if not encrypted)",
    "zh-cn": "解密密码（未加密请留空）",
    "zh-tw": "解密密碼（未加密請留空）",
  },
  "password.encryptHint": {
    en: "Set encryption password",
    "zh-cn": "设置加密密码",
    "zh-tw": "設定加密密碼",
  },
  "password.prompt": {
    en: "Enter AES-256 encryption/decryption password (leave blank to skip)",
    "zh-cn": "输入 AES-256 加密/解密密码（留空跳过）",
    "zh-tw": "輸入 AES-256 加密/解密密碼（留空跳過）",
  },

  // ---- Timing ----
  "time.elapsed": {
    en: " ({0})",
    "zh-cn": "（耗时 {0}）",
    "zh-tw": "（耗時 {0}）",
  },

  // ---- Copy / Paste ----
  "archive.copyNone": {
    en: "No files copied from archive. Select files in the archive preview and press Ctrl+C first.",
    "zh-cn": "尚未从压缩包复制文件。请先在预览中选中文件并按 Ctrl+C。",
    "zh-tw": "尚未從壓縮檔複製檔案。請先在預覽中選取檔案並按 Ctrl+C。",
  },
  "archive.pasteHere": {
    en: "Paste extracted files here",
    "zh-cn": "将复制的文件解压到此处",
    "zh-tw": "將複製的檔案解壓到此處",
  },
  "archive.copied": {
    en: "Copied {0} item(s) from archive",
    "zh-cn": "已从压缩包复制 {0} 个项目",
    "zh-tw": "已從壓縮檔複製 {0} 個項目",
  },
  "archive.pasteAction": {
    en: "Paste Files...",
    "zh-cn": "粘贴文件...",
    "zh-tw": "貼上檔案...",
  },
  "archive.sourceMissing": {
    en: "The source archive no longer exists: {0}",
    "zh-cn": "源压缩包文件已不存在: {0}",
    "zh-tw": "來源壓縮檔已不存在: {0}",
  },
};

/**
 * Detect current VSCode locale.
 * Maps VSCode locale string to our internal Locale type.
 * Cached after first call — locale doesn't change at runtime.
 */
let _cachedLocale: Locale | null = null;

function detectLocale(): Locale {
  if (_cachedLocale) return _cachedLocale;
  const lang = vscode.env.language.toLowerCase();
  if (lang.startsWith("zh-cn") || lang === "zh-hans") _cachedLocale = "zh-cn";
  else if (lang.startsWith("zh-tw") || lang === "zh-hant") _cachedLocale = "zh-tw";
  else if (lang.startsWith("zh")) _cachedLocale = "zh-cn";
  else _cachedLocale = "en";
  return _cachedLocale;
}

/**
 * Get a localized UI string by key.
 *
 * @param key - Message key from the dictionary above
 * @param args - Optional positional arguments for placeholder replacement ({0}, {1}, ...)
 * @returns Localized string
 *
 * @example
 *   t('compress.done') + outputPath
 *   t('compress.addedItems', String(count))
 */
export function t(key: string, ...args: string[]): string {
  const locale = detectLocale();
  const entry = messages[key];
  if (!entry) return key;

  let text = entry[locale] ?? entry.en;
  for (let i = 0; i < args.length; i++) {
    text = text.replace(`{${i}}`, args[i]);
  }
  return text;
}

export { formatDuration, formatCompactSize } from "./utils/format";

const COMPRESSION_LEVEL_LABELS: Record<Locale, string[]> = {
  en: ["0 – Store (fastest)", "1 – Fastest", "3 – Fast", "5 – Normal", "7 – Maximum", "9 – Ultra"],
  "zh-cn": ["0 – 仅打包（最快）", "1 – 极速", "3 – 快速", "5 – 标准", "7 – 最大", "9 – 极限"],
  "zh-tw": ["0 – 僅打包（最快）", "1 – 極速", "3 – 快速", "5 – 標準", "7 – 最大", "9 – 極限"],
};

export function compressLevels(): string[] {
  return COMPRESSION_LEVEL_LABELS[detectLocale()];
}
