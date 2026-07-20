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
    en: "RAR creation is not supported by free/open-source tools.\nConsider using 7z or ZIP format.\nRAR extraction is fully supported.",
    "zh-cn":
      "RAR 格式创建不受免费/开源工具支持。\n建议使用 7z 或 ZIP 格式。\nRAR 解压功能已完整支持。",
    "zh-tw":
      "RAR 格式建立不受免費/開源工具支援。\n建議使用 7z 或 ZIP 格式。\nRAR 解壓功能已完整支援。",
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
  "compress.selectTargetFormat": {
    en: "Select target format for conversion",
    "zh-cn": "选择转换目标格式",
    "zh-tw": "選取轉換目標格式",
  },
  "compress.selectVolume": {
    en: "Split into volumes? (optional)",
    "zh-cn": "分卷压缩？(可选)",
    "zh-tw": "分卷壓縮？(可選)",
  },
  "compress.volume.none": {
    en: "Don't split",
    "zh-cn": "不分卷",
    "zh-tw": "不分卷",
  },
  "compress.volume.custom": {
    en: "Custom...",
    "zh-cn": "自定义...",
    "zh-tw": "自訂...",
  },
  "compress.volume.prompt": {
    en: "Volume size (number + k/m/g suffix, e.g. 100m, 1g, 650m)",
    "zh-cn": "分卷大小 (数字 + k/m/g 后缀，如 100m, 1g, 650m)",
    "zh-tw": "分卷大小 (數字 + k/m/g 後綴，如 100m, 1g, 650m)",
  },
  "compress.volume.invalid": {
    en: "Invalid format. Use a number followed by k, m, or g (e.g. 100m, 1g)",
    "zh-cn": "格式无效。请使用数字加 k/m/g 后缀 (如 100m, 1g)",
    "zh-tw": "格式無效。請使用數字加 k/m/g 後綴 (如 100m, 1g)",
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
  "decompress.missingVolumes": {
    en: "One or more split volume parts are missing. All parts must be in the same directory.",
    "zh-cn": "缺少一个或多个分卷文件。所有分卷必须位于同一目录。",
    "zh-tw": "缺少一個或多個分割檔案。所有分割檔必須位於同一目錄。",
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
  "save.namePrompt": {
    en: 'Output name (".{0}" will be appended)',
    "zh-cn": "压缩包名称（将自动附加 .{0}）",
    "zh-tw": "封存檔名稱（將自動附加 .{0}）",
  },
  "save.nameInvalid": {
    en: 'Invalid characters: < > : " / \\ | ? *',
    "zh-cn": '非法字符：< > : " / \\ | ? *',
    "zh-tw": '無效字元：< > : " / \\ | ? *',
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
  "password.wrongPassword": {
    en: "Wrong password",
    "zh-cn": "密码错误",
    "zh-tw": "密碼錯誤",
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
  "archive.copyReplaced": {
    en: 'Replaced copied items from "{0}" with "{1}"',
    "zh-cn": '已将复制的项目从 "{0}" 替换为 "{1}"',
    "zh-tw": '已將複製的項目從 "{0}" 替換為 "{1}"',
  },
  "archive.addFilesLabel": {
    en: "Add to Archive",
    "zh-cn": "添加到压缩包",
    "zh-tw": "新增到壓縮檔",
  },
  "archive.toastDeleted": {
    en: "Deleted {0} item(s)",
    "zh-cn": "已删除 {0} 项",
    "zh-tw": "已刪除 {0} 項",
  },
  "archive.toastRenamed": {
    en: "Renamed",
    "zh-cn": "已重命名",
    "zh-tw": "已重新命名",
  },
  "archive.toastCreatedFolder": {
    en: "Folder created",
    "zh-cn": "文件夹已创建",
    "zh-tw": "資料夾已建立",
  },
  "archive.toastAddedFiles": {
    en: "Files added",
    "zh-cn": "文件已添加",
    "zh-tw": "檔案已新增",
  },
  "archive.readOnly": {
    en: "Read-only archive — browse and extract only",
    "zh-cn": "只读归档 — 仅可浏览和解压",
    "zh-tw": "唯讀封存 — 僅可瀏覽和解壓",
  },
  "archive.addedFiles": {
    en: "Added {0} file(s) to archive: ",
    "zh-cn": "已向压缩包添加 {0} 个文件: ",
    "zh-tw": "已向壓縮檔新增 {0} 個檔案: ",
  },
  "archive.addingFiles": {
    en: "Adding files to ",
    "zh-cn": "正在向压缩包添加文件: ",
    "zh-tw": "正在向壓縮檔新增檔案: ",
  },
  // ---- Security / Validation ----
  "security.passwordStartDash": {
    en: "Password must not start with '-'",
    "zh-cn": "密码不能以 '-' 开头",
    "zh-tw": "密碼不能以 '-' 開頭",
  },
  "security.passwordNullByte": {
    en: "Password contains null byte",
    "zh-cn": "密码包含空字节",
    "zh-tw": "密碼包含空字節",
  },
  "security.passwordNewline": {
    en: "Password contains newline",
    "zh-cn": "密码包含换行符",
    "zh-tw": "密碼包含換行符",
  },
  "security.fileSizeExceeded": {
    en: "File size {0} exceeds maximum {1}",
    "zh-cn": "文件大小 {0} 超过最大限制 {1}",
    "zh-tw": "檔案大小 {0} 超過最大限制 {1}",
  },
  "security.totalSizeExceeded": {
    en: "Total decompressed size {0} exceeds maximum {1}",
    "zh-cn": "解压后总大小 {0} 超过最大限制 {1}",
    "zh-tw": "解壓後總大小 {0} 超過最大限制 {1}",
  },
  "security.decompressionBomb": {
    en: "Decompression bomb: reported {0}B but decompressed to {1}B",
    "zh-cn": "检测到解压炸弹: 报告 {0}B 但解压后为 {1}B",
    "zh-tw": "偵測到解壓炸彈: 報告 {0}B 但解壓後為 {1}B",
  },
  "security.pathTraversal": {
    en: "Invalid directory: path traversal not allowed",
    "zh-cn": "无效目录: 不允许路径遍历",
    "zh-tw": "無效目錄: 不允許路徑遍歷",
  },
  "security.passwordEmpty": {
    en: "Password cannot be empty for encryption",
    "zh-cn": "加密密码不能为空",
    "zh-tw": "加密密碼不能為空",
  },
  "decompress.rarVolume": {
    en: 'Multi-volume RAR: "{0}" requires a .rar file in the same directory.',
    "zh-cn": '多卷 RAR: "{0}" 需要同目录下的 .rar 文件。',
    "zh-tw": '多卷 RAR: "{0}" 需要同目錄下的 .rar 檔案。',
  },

  // ---- Password UI ----
  "password.show": {
    en: "Show password",
    "zh-cn": "显示密码",
    "zh-tw": "顯示密碼",
  },
  "password.hide": {
    en: "Hide password",
    "zh-cn": "隐藏密码",
    "zh-tw": "隱藏密碼",
  },
  "input.clear": {
    en: "Clear",
    "zh-cn": "清除",
    "zh-tw": "清除",
  },

  // ---- Wizard steps ----
  "wizard.step.format": {
    en: "Format",
    "zh-cn": "格式",
    "zh-tw": "格式",
  },
  "wizard.step.level": {
    en: "Step 2: Level",
    "zh-cn": "第 2 步：压缩级别",
    "zh-tw": "第 2 步：壓縮級別",
  },
  "wizard.step.volume": {
    en: "Step 3: Volume size",
    "zh-cn": "第 3 步：分卷大小",
    "zh-tw": "第 3 步：分卷大小",
  },
  "wizard.step.encrypt": {
    en: "Step 4: Encryption",
    "zh-cn": "第 4 步：加密",
    "zh-tw": "第 4 步：加密",
  },

  // ---- Archive operations ----
  "delete.confirm": {
    en: "Delete",
    "zh-cn": "删除",
    "zh-tw": "刪除",
  },
  "archive.deleting": {
    en: "Deleting...",
    "zh-cn": "正在删除...",
    "zh-tw": "正在刪除...",
  },
  "archive.deletingProgress": {
    en: "Delete {0} selected item(s) from archive? This cannot be undone.",
    "zh-cn": "确定要从压缩包中永久删除 {0} 个选中项吗？",
    "zh-tw": "確定要從壓縮檔中永久刪除 {0} 個選中項嗎？",
  },
  "archive.renaming": {
    en: "Renaming...",
    "zh-cn": "正在重命名...",
    "zh-tw": "正在重新命名...",
  },
  "archive.addingFilesProgress": {
    en: "Adding files...",
    "zh-cn": "正在添加文件...",
    "zh-tw": "正在新增檔案...",
  },
  "archive.creatingFolder": {
    en: "Creating folder...",
    "zh-cn": "正在创建文件夹...",
    "zh-tw": "正在建立資料夾...",
  },
  "archive.converting": {
    en: "Converting...",
    "zh-cn": "正在转换格式...",
    "zh-tw": "正在轉換格式...",
  },
  "archive.merging": {
    en: "Merging volumes...",
    "zh-cn": "正在合并分卷...",
    "zh-tw": "正在合併分卷...",
  },
  "archive.splitting": {
    en: "Splitting...",
    "zh-cn": "正在分割分卷...",
    "zh-tw": "正在分割分卷...",
  },
  "archive.encrypting": {
    en: "Encrypting...",
    "zh-cn": "正在加密...",
    "zh-tw": "正在加密...",
  },
  "archive.decrypting": {
    en: "Decrypting...",
    "zh-cn": "正在解密...",
    "zh-tw": "正在解密...",
  },
  "archive.renamePrompt": {
    en: "Rename to",
    "zh-cn": "重命名为",
    "zh-tw": "重新命名為",
  },
  "archive.folderNamePrompt": {
    en: "Folder name",
    "zh-cn": "文件夹名称",
    "zh-tw": "資料夾名稱",
  },
  "archive.folderNamePlaceholder": {
    en: "new-folder",
    "zh-cn": "新建文件夹",
    "zh-tw": "新建資料夾",
  },
  "archive.encryptPrompt": {
    en: "Enter a password to encrypt this archive",
    "zh-cn": "输入密码以加密此压缩包",
    "zh-tw": "輸入密碼以加密此壓縮檔",
  },
  "archive.encryptConfirm": {
    en: "Confirm encryption password",
    "zh-cn": "确认加密密码",
    "zh-tw": "確認加密密碼",
  },
  "archive.decryptPrompt": {
    en: "Enter the archive password to decrypt",
    "zh-cn": "输入压缩包密码以解密",
    "zh-tw": "輸入壓縮檔密碼以解密",
  },

  // ---- Validation ----
  "validation.nameEmpty": {
    en: "Name cannot be empty",
    "zh-cn": "名称不能为空",
    "zh-tw": "名稱不能為空",
  },
  "validation.nameInvalidChar": {
    en: "Invalid character",
    "zh-cn": "无效字符",
    "zh-tw": "無效字元",
  },
  "validation.nameInvalidChars": {
    en: 'Invalid characters: < > : " / \\ | ? *',
    "zh-cn": '非法字符：< > : " / \\ | ? *',
    "zh-tw": '無效字元：< > : " / \\ | ? *',
  },
  "validation.nameSameName": {
    en: "New name is the same as current",
    "zh-cn": "新名称与当前名称相同",
    "zh-tw": "新名稱與當前名稱相同",
  },
  "validation.nameTooLong": {
    en: "Name too long",
    "zh-cn": "名称过长",
    "zh-tw": "名稱過長",
  },
  "validation.passwordMismatch": {
    en: "Passwords do not match",
    "zh-cn": "密码不匹配",
    "zh-tw": "密碼不匹配",
  },

  // ---- Add to archive QuickPick ----
  "addToArchive.addFiles": {
    en: "Add Files",
    "zh-cn": "添加文件",
    "zh-tw": "新增檔案",
  },
  "addToArchive.addFilesDesc": {
    en: "Select individual files",
    "zh-cn": "选择单个文件",
    "zh-tw": "選取個別檔案",
  },
  "addToArchive.addFolders": {
    en: "Add Folders",
    "zh-cn": "添加文件夹",
    "zh-tw": "新增資料夾",
  },
  "addToArchive.addFoldersDesc": {
    en: "Select whole folders",
    "zh-cn": "选择整个文件夹",
    "zh-tw": "選取整個資料夾",
  },
  "addToArchive.addBoth": {
    en: "Add Both",
    "zh-cn": "添加文件和文件夹",
    "zh-tw": "新增檔案和資料夾",
  },
  "addToArchive.addBothDesc": {
    en: "Select files then folders",
    "zh-cn": "依次选择文件和文件夹",
    "zh-tw": "依序選取檔案和資料夾",
  },

  // ---- Size limit ----
  "security.extractAnyway": {
    en: "Extract anyway",
    "zh-cn": "仍然解压",
    "zh-tw": "仍然解壓",
  },
  "security.passwordTooLong": {
    en: "Password too long (max 1024 characters)",
    "zh-cn": "密码过长（最多 1024 个字符）",
    "zh-tw": "密碼過長（最多 1024 個字元）",
  },
  "security.notValidRar": {
    en: "Not a valid RAR archive (bad header)",
    "zh-cn": "不是有效的 RAR 压缩文件（文件头错误）",
    "zh-tw": "不是有效的 RAR 壓縮檔（檔案頭錯誤）",
  },

  // ---- Preview ----
  "preview.opening": {
    en: "Opening preview...",
    "zh-cn": "正在打开预览...",
    "zh-tw": "正在開啟預覽...",
  },
  "preview.notFound": {
    en: "Preview file not found: {0}",
    "zh-cn": "预览文件未找到: {0}",
    "zh-tw": "預覽檔案未找到: {0}",
  },
  "preview.notFoundInner": {
    en: "Preview file not found in inner archive: {0}",
    "zh-cn": "在内层压缩包中未找到预览文件: {0}",
    "zh-tw": "在內層壓縮檔中未找到預覽檔案: {0}",
  },
  "preview.fileTooLarge": {
    en: "File too large for preview ({0} bytes, max {1} bytes). Use Extract instead.",
    "zh-cn": "文件过大，无法预览 ({0} 字节，最大 {1} 字节)。请使用提取功能。",
    "zh-tw": "檔案過大，無法預覽 ({0} 位元組，最大 {1} 位元組)。請使用提取功能。",
  },

  // ---- Test ----
  "test.passed": {
    en: "Archive integrity test passed",
    "zh-cn": "压缩包完整性测试通过",
    "zh-tw": "壓縮檔完整性測試通過",
  },
  "test.warnings": {
    en: "Test completed with warnings:\n",
    "zh-cn": "测试完成，但有警告：\n",
    "zh-tw": "測試完成，但有警告：\n",
  },

  // ---- Add to archive dialog ----
  "addToArchive.chooseWhat": {
    en: "Choose what to add to the archive",
    "zh-cn": "选择要添加到压缩包的内容",
    "zh-tw": "選擇要新增到壓縮檔的內容",
  },
  "addToArchive.selectFiles": {
    en: "Select Files",
    "zh-cn": "选择文件",
    "zh-tw": "選取檔案",
  },
  "addToArchive.selectFolders": {
    en: "Select Folders",
    "zh-cn": "选择文件夹",
    "zh-tw": "選取資料夾",
  },
  "addToArchive.select": {
    en: "Select",
    "zh-cn": "选择",
    "zh-tw": "選取",
  },

  // ---- Generic ----
  "generic.copy": {
    en: "Copy",
    "zh-cn": "复制",
    "zh-tw": "複製",
  },

  // ---- Decompress errors ----
  "decompress.cannotRead": {
    en: "Cannot read file",
    "zh-cn": "无法读取文件",
    "zh-tw": "無法讀取檔案",
  },
  "decompress.noSplitParts": {
    en: 'No split volume parts found for "{0}". Ensure all parts are in the same directory.',
    "zh-cn": '未找到 "{0}" 的分卷文件，请确保所有分卷位于同一目录。',
    "zh-tw": '未找到 "{0}" 的分割檔案，請確保所有分割檔位於同一目錄。',
  },

  // ---- Zstd ----
  "zstd.notAvailable": {
    en: "zstd not available. Install: winget install zstd (Win), brew install zstd (Mac), apt/dnf install zstd (Linux)",
    "zh-cn":
      "zstd 不可用。请安装: winget install zstd (Win), brew install zstd (Mac), apt/dnf install zstd (Linux)",
    "zh-tw":
      "zstd 不可用。請安裝: winget install zstd (Win), brew install zstd (Mac), apt/dnf install zstd (Linux)",
  },

  // ---- Archive operations ----
  "archive.noInnerTar": {
    en: "Wrapped archive: no inner TAR found",
    "zh-cn": "包裹归档: 未找到内部 TAR",
    "zh-tw": "包裹封存: 未找到內部 TAR",
  },

  // ---- Security dialogs ----
  "security.oversizeWarning": {
    en: "{0} is {1}, exceeding the limit of {2}.\n\nExtracting may cause high memory usage or disk exhaustion.",
    "zh-cn": "{0} 大小为 {1}，超过了 {2} 的限制。\n\n解压可能导致高内存占用或磁盘耗尽。",
    "zh-tw": "{0} 大小為 {1}，超過了 {2} 的限制。\n\n解壓可能導致高記憶體佔用或磁碟耗盡。",
  },

  // ---- System 7-Zip ----
  "system7z.notInstalled": {
    en: 'System 7-Zip is not installed. Set smart-archive.useSystem7z to "auto" or "never" to use the bundled engine.',
    "zh-cn":
      '未安装系统 7-Zip。请将 smart-archive.useSystem7z 设为 "auto" 或 "never" 以使用内置引擎。',
    "zh-tw":
      '未安裝系統 7-Zip。請將 smart-archive.useSystem7z 設為 "auto" 或 "never" 以使用內建引擎。',
  },
  "system7z.tooOld": {
    en: 'System 7-Zip version is too old (requires v21+). Install a newer version or set smart-archive.useSystem7z to "never".',
    "zh-cn":
      '系统 7-Zip 版本太旧（需要 v21+）。请安装新版本或将 smart-archive.useSystem7z 设为 "never"。',
    "zh-tw":
      '系統 7-Zip 版本太舊（需要 v21+）。請安裝新版本或將 smart-archive.useSystem7z 設為 "never"。',
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
    text = text.split(`{${i}}`).join(args[i]);
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
