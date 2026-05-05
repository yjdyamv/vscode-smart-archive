import type { FileIcon } from "../types";

const FILE_NAME_MAP: Record<string, string> = {
  dockerfile: "server",
  "dockerfile.prod": "server",
  "dockerfile.dev": "server",
  makefile: "tools",
  cmakelists: "tools",
  license: "law",
  "license.md": "law",
  "license.txt": "law",
  copying: "law",
  changelog: "book",
  "changelog.md": "book",
  "changelog.txt": "book",
  readme: "book",
  "readme.md": "book",
  "readme.txt": "book",
  contributing: "book",
  "contributing.md": "book",
  codeowners: "organization",
  "package.json": "package",
  "package-lock.json": "lock",
  "yarn.lock": "lock",
  "pnpm-lock.yaml": "lock",
  "pnpm-lock.yml": "lock",
  "cargo.lock": "lock",
  "gemfile.lock": "lock",
  "composer.lock": "lock",
  "poetry.lock": "lock",
  "tsconfig.json": "settings-gear",
  "jsconfig.json": "settings-gear",
  "docker-compose.yml": "server",
  "docker-compose.yaml": "server",
  "compose.yml": "server",
  "compose.yaml": "server",
  "babel.config.js": "settings-gear",
  "babel.config.cjs": "settings-gear",
  "babel.config.mjs": "settings-gear",
  "vite.config.ts": "settings-gear",
  "vite.config.js": "settings-gear",
  "webpack.config.js": "settings-gear",
  "rollup.config.js": "settings-gear",
  "eslint.config.js": "settings-gear",
  "eslint.config.mjs": "settings-gear",
  "jest.config.ts": "beaker",
  "jest.config.js": "beaker",
  "vitest.config.ts": "beaker",
  "vitest.config.js": "beaker",
};

const FILE_ICONS: { exts: string[]; codicon: string }[] = [
  // ── Images / Audio / Video ──
  {
    exts: [
      "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tiff",
      "tif", "psd", "ai", "heic", "heif", "avif", "icns", "raw", "nef",
      "cr2", "arw", "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a",
      "opus", "mid", "midi", "mp4", "avi", "mkv", "mov", "wmv", "webm",
      "m4v", "mpg", "mpeg", "3gp", "ogv", "swf", "fla", "smil",
    ],
    codicon: "file-media",
  },

  // ── Systems languages ─ symbol-structure ──
  {
    exts: [
      "c", "cpp", "cc", "cxx", "c++", "h", "hpp", "hxx", "h++",
      "rs", "rlib", "rmeta", "go", "zig", "nim", "odin", "v", "cr",
    ],
    codicon: "symbol-structure",
  },

  // ── Dynamic / scripting languages ─ symbol-method ──
  {
    exts: [
      "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
      "py", "pyw", "pyx", "pxd", "pxi",
      "php", "phtml", "lua", "pl", "pm", "dart",
    ],
    codicon: "symbol-method",
  },

  // ── Class-heavy languages ─ symbol-class ──
  {
    exts: ["java", "kt", "kts", "cs", "scala", "sc", "groovy"],
    codicon: "symbol-class",
  },

  // ── Functional languages ─ symbol-operator ──
  {
    exts: [
      "hs", "lhs", "ex", "exs", "clj", "cljs", "cljc", "edn",
      "erl", "hrl", "elm", "fs", "fsx", "fsi", "wren", "res", "resi",
    ],
    codicon: "symbol-operator",
  },

  // ── Swift ─ symbol-field ──
  { exts: ["swift"], codicon: "symbol-field" },

  // ── Ruby ─ 专属图标 ──
  { exts: ["rb", "erb", "gemfile", "rakefile"], codicon: "ruby" },

  // ── Data science ─ graph ──
  { exts: ["r", "rmd", "rnw", "rproj", "jl", "ipynb"], codicon: "graph" },

  // ── CSS / styles ─ 专属图标 ──
  { exts: ["css", "scss", "sass", "less", "styl", "stylus", "pcss", "postcss"], codicon: "css" },

  // ── Markdown ─ 专属图标 ──
  { exts: ["md", "mdx", "markdown", "mdc", "mdwn", "mkd", "mkdn", "ronn"], codicon: "markdown" },

  // ── JSON ─ 专属图标 ──
  { exts: ["json", "jsonc", "json5"], codicon: "json" },

  // ── Web markup ─ globe ──
  { exts: ["html", "htm", "xml", "xsl", "xslt", "vue", "svelte", "astro"], codicon: "globe" },

  // ── Config ─ settings-gear ──
  {
    exts: [
      "yaml", "yml", "toml", "ini", "cfg", "conf", "config",
      "properties", "env", "envrc", "editorconfig", "npmrc", "browserslistrc",
    ],
    codicon: "settings-gear",
  },

  // ── Shell scripts ─ terminal ──
  {
    exts: [
      "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1",
      "psd1", "psm1", "bashrc", "bash_profile", "zshrc", "profile",
    ],
    codicon: "terminal",
  },

  // ── Archives ─ file-zip ──
  {
    exts: [
      "zip", "gz", "bz2", "xz", "7z", "rar", "tar",
      "zst", "lz", "lzma", "tgz", "tbz2", "tbz", "txz",
      "tzst", "tlz", "cab", "arj", "lzh", "rpm", "deb",
      "apk", "aar", "jar", "war", "ear", "whl", "egg",
      "z", "cpio", "xar", "uha", "dex",
    ],
    codicon: "file-zip",
  },

  // ── Documents ──
  { exts: ["pdf"], codicon: "file-pdf" },
  {
    exts: [
      "txt", "text", "log", "doc", "docx", "xls", "xlsx",
      "ppt", "pptx", "rtf", "csv", "tsv", "odt", "ods", "odp",
    ],
    codicon: "file-text",
  },

  // ── Database ─ database ──
  { exts: ["sql", "db", "sqlite", "sqlite3", "mdb", "accdb", "prisma", "dgraph", "cypher"], codicon: "database" },

  // ── Binary / executables ──
  {
    exts: [
      "exe", "dll", "so", "dylib", "bin", "app", "msi", "pkg",
      "elf", "macho", "out", "obj", "o", "lib", "a", "sys", "ko",
    ],
    codicon: "file-binary",
  },

  // ── Others ──
  { exts: ["lock"], codicon: "lock" },
  { exts: ["gitignore", "gitattributes", "dockerignore", "npmignore"], codicon: "settings" },
  { exts: ["gitmodules"], codicon: "file-submodule" },
  { exts: ["wasm", "wat"], codicon: "package" },
  { exts: ["ttf", "otf", "woff", "woff2", "eot", "ttc"], codicon: "symbol-string" },
  { exts: ["pem", "crt", "cer", "key", "p12", "pfx", "der", "csr", "p7b", "p7c"], codicon: "key" },
  { exts: ["vhd", "vmdk", "iso", "qcow2", "dmg", "img", "fat", "ntfs", "vdi", "vhdx"], codicon: "vm" },
  { exts: ["graphql", "gql"], codicon: "project" },
  { exts: ["proto", "protobuf"], codicon: "symbol-misc" },
  { exts: ["cjsx"], codicon: "symbol-method" },
];

const EXT_ICON_MAP: Record<string, string> = {};
for (const row of FILE_ICONS) {
  for (const e of row.exts) {
    EXT_ICON_MAP[e] = row.codicon;
  }
}

export function getFileIcon(name: string, isDir: boolean): FileIcon {
  if (isDir) return { codicon: "folder" };
  const lower = name.toLowerCase();
  if (FILE_NAME_MAP[lower]) return { codicon: FILE_NAME_MAP[lower] };
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
