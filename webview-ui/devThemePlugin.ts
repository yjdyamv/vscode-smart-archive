/**
 * VS Code theme dev plugin — Smart Archive webview
 *
 * Serves the VS Code theme the developer currently has active as
 * `/__sa-theme.json` on the vite dev server, so the browser preview
 * (`npm run dev:webview`) renders with the REAL theme instead of a
 * hardcoded palette. Resolves `workbench.colorTheme` from the workspace
 * and user settings, maps the theme id to its JSONC theme file (built-in
 * VS Code themes and user-installed extensions), and returns the raw
 * theme file; 404 when nothing can be resolved (the browser falls back).
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import * as vscodePath from "path";
import { parse } from "jsonc-parser";
import type { Plugin } from "vite";

const ENDPOINT = "/__sa-theme.json";

const USER_SETTINGS_CANDIDATES = [
  ".config/Code/User/settings.json",
  ".config/Code - Insiders/User/settings.json",
  "Library/Application Support/Code/User/settings.json",
  "Library/Application Support/Code - Insiders/User/settings.json",
  "AppData/Roaming/Code/User/settings.json",
  "AppData/Roaming/Code - Insiders/User/settings.json",
];

/** Well-known VS Code install extension directories (linux/mac/win). */
const INSTALL_EXT_DIRS = [
  "/usr/share/code/resources/app/extensions",
  "/usr/lib/code/resources/app/extensions",
  "/opt/visual-studio-code/resources/app/extensions",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
];

function readJsonc(file: string): unknown {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function userSettingsDir(): string {
  const home = homedir();
  for (const rel of USER_SETTINGS_CANDIDATES) {
    const p = path.join(home, rel);
    if (existsSync(p)) return path.dirname(p);
  }
  return "";
}

/** Collect every theme id → file map from a directory of extensions. */
function collectThemes(extensionsDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(extensionsDir)) return map;
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = vscodePath.join(extensionsDir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = readJsonc(pkgPath) as {
      contributes?: { themes?: { id?: string; label?: string; path?: string }[] };
    };
    for (const theme of pkg?.contributes?.themes ?? []) {
      if (!theme.path) continue;
      const file = vscodePath.join(extensionsDir, entry.name, theme.path);
      // VS Code stores the theme id when present, else the label — index both.
      if (theme.id) map.set(theme.id, file);
      if (theme.label) map.set(theme.label, file);
    }
  }
  return map;
}

function themeSources(): string[] {
  const sources: string[] = [...INSTALL_EXT_DIRS];
  const home = homedir();
  for (const rel of [".vscode/extensions", ".vscode-insiders/extensions"]) {
    sources.push(vscodePath.join(home, rel));
  }
  return sources;
}

function resolveThemeFile(themeId: string): string | undefined {
  for (const dir of themeSources()) {
    const hit = collectThemes(dir).get(themeId);
    if (hit) return hit;
  }
  return undefined;
}

function currentThemeId(): string {
  const candidates = [
    vscodePath.join(process.cwd(), ".vscode", "settings.json"),
    ...USER_SETTINGS_CANDIDATES.map((rel) => vscodePath.join(homedir(), rel)),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const settings = readJsonc(file) as { "workbench.colorTheme"?: string };
    const id = settings?.["workbench.colorTheme"];
    if (id) return id;
  }
  return "Dark Modern";
}

export function devThemePlugin(): Plugin {
  return {
    name: "smart-archive-dev-theme",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (url !== ENDPOINT) return next();
        const themeFile = resolveThemeFile(currentThemeId());
        if (!themeFile) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "no theme resolved" }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(readFileSync(themeFile));
      });
    },
  };
}
