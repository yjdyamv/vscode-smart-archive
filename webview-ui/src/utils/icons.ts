import type { FileIcon } from "../types";

const FILE_ICONS: { exts: string[]; codicon: string }[] = [
  { exts: ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tiff"], codicon: "file-media" },
  {
    exts: [
      "ts", "tsx", "js", "jsx", "py", "rb", "rs", "go", "java", "c", "cpp",
      "h", "swift", "kt", "cs", "php", "r",
    ],
    codicon: "file-code",
  },
  { exts: ["css", "scss", "less", "sass"], codicon: "symbol-color" },
  { exts: ["html", "htm", "xml", "vue", "svelte"], codicon: "globe" },
  { exts: ["json", "yaml", "yml", "toml", "ini", "cfg"], codicon: "settings-gear" },
  { exts: ["zip", "gz", "bz2", "xz", "7z", "rar", "tar", "zst"], codicon: "file-zip" },
  { exts: ["pdf"], codicon: "file-pdf" },
  { exts: ["md"], codicon: "markdown" },
  { exts: ["txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx"], codicon: "file-text" },
  { exts: ["sh", "bash", "bat", "ps1", "zsh", "fish"], codicon: "terminal" },
  { exts: ["sql", "db", "sqlite", "sqlite3"], codicon: "database" },
  { exts: ["exe", "dll", "so", "dylib"], codicon: "file-binary" },
  { exts: ["lock"], codicon: "lock" },
  { exts: ["env"], codicon: "settings-gear" },
  { exts: ["gitignore"], codicon: "git-ignore" },
  { exts: ["wasm"], codicon: "file-binary" },
];

const EXT_ICON_MAP: Record<string, string> = {};
for (const row of FILE_ICONS) {
  for (const e of row.exts) {
    EXT_ICON_MAP[e] = row.codicon;
  }
}

export function getFileIcon(name: string, isDir: boolean): FileIcon {
  if (isDir) return { codicon: "folder" };
  const ext = (name.split(".").pop() || "").toLowerCase();
  const icon = EXT_ICON_MAP[ext] ?? "file";
  return { codicon: icon };
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(size < 10 ? 1 : 0) + " " + units[i];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
