import type { FileIcon } from "../types";

const FILE_ICONS: { exts: string[]; color: string; emoji: string }[] = [
  {
    exts: ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tiff"],
    color: "#4caf50",
    emoji: "\u{1F5BC}",
  },
  {
    exts: [
      "ts", "tsx", "js", "jsx", "py", "rb", "rs", "go", "java", "c", "cpp",
      "h", "swift", "kt", "cs", "php", "r",
    ],
    color: "#3178c6",
    emoji: "\u{1F4DD}",
  },
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

const EXT_ICON_MAP: Record<string, { color: string; emoji: string }> = {};
for (const row of FILE_ICONS) {
  for (const e of row.exts) {
    EXT_ICON_MAP[e] = { color: row.color, emoji: row.emoji };
  }
}

export function getFileIcon(name: string, isDir: boolean): FileIcon {
  if (isDir) return { color: "#dcb67a", emoji: "\u{1F4C1}" };
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_ICON_MAP[ext] ?? { color: "#9e9e9e", emoji: "\u{1F4C4}" };
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
