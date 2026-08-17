/**
 * Dynamic VS Code theme loader for the browser dev preview — Smart Archiver
 * webview
 *
 * `npm run dev:webview` renders the UI in a plain browser, where VS Code's
 * injected --vscode-* variables do not exist. Load the developer's ACTIVE
 * theme instead: the vite dev server resolves `workbench.colorTheme` from
 * the local VS Code settings and serves the theme file at
 * `/__sa-theme.json` (devThemePlugin). Falls back to the VS Code default
 * themes by OS color scheme, then to a neutral palette, when the endpoint
 * is unavailable.
 *
 * Only ever imported under dev mode — never ships in the panel.
 */

import { parse } from "jsonc-parser";

interface ThemeJson {
  colors?: Record<string, string>;
}

const GITHUB_THEME_URLS = {
  dark: "https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-defaults/themes/dark_modern.json",
  light:
    "https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-defaults/themes/light_modern.json",
};

/**
 * Neutral fallback palette, applied before the fetch resolves and used for
 * any variable the loaded theme does not define (VS Code synthesizes many
 * of these — e.g. list.hoverBackground — from theme colors).
 */
const FALLBACK_PALETTE: Record<string, string> = {
  "--vscode-sideBar-background": "#1e1e1e",
  "--vscode-sideBarSectionHeader-background": "#252526",
  "--vscode-sideBarSectionHeader-border": "#3c3c3c",
  "--vscode-editor-background": "#1e1e1e",
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-panel-border": "#3c3c3c",
  "--vscode-progressBar-background": "#0e70c0",
  "--vscode-focusBorder": "#007fd4",
  "--vscode-toolbar-hoverBackground": "rgba(90, 93, 94, 0.31)",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-background": "#3c3c3c",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-button-background": "#0e639c",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#1177bb",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-list-activeSelectionBackground": "#04395e",
  "--vscode-list-activeSelectionForeground": "#ffffff",
  "--vscode-checkbox-background": "#3c3c3c",
  "--vscode-checkbox-border": "#3c3c3c",
  "--vscode-checkbox-selectBackground": "#3c3c3c",
  "--vscode-checkbox-selectBorder": "#3c3c3c",
  "--vscode-checkbox-selectForeground": "#f0f0f0",
  "--vscode-editor-findMatchHighlightBackground": "#614922",
  "--vscode-menu-background": "#252526",
  "--vscode-menu-border": "#454545",
  "--vscode-menu-selectionBackground": "#04395e",
  "--vscode-scrollbarSlider-background": "rgba(121, 121, 121, 0.4)",
  "--vscode-scrollbarSlider-hoverBackground": "rgba(100, 100, 100, 0.7)",
  "--vscode-statusBar-background": "#007acc",
  "--vscode-terminal-ansiGreen": "#4ec9b0",
  "--vscode-tree-indentGuidesStroke": "#3c3c3c",
  "--vscode-inputValidation-errorBackground": "#5a1d1d",
  "--vscode-inputValidation-errorBorder": "#be1100",
  "--vscode-inputValidation-errorForeground": "#f48771",
  "--vscode-font-family": "system-ui, -apple-system, sans-serif",
  "--vscode-font-size": "14px",
};

/**
 * Variables synthesized by VS Code rather than read straight from a theme
 * color: mapped from a different theme key.
 */
const SYNTHESIZED: Record<string, string> = {
  "--vscode-foreground": "editor.foreground",
};

/** Theme files are JSONC (comments and trailing commas allowed). */
function parseThemeJson(text: string): ThemeJson {
  return parse(text) as ThemeJson;
}

async function fetchThemeJson(url: string): Promise<Record<string, string>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`theme fetch ${res.status}`);
  const json = parseThemeJson(await res.text());
  return json.colors ?? {};
}

/** Apply a theme color map over the fallback palette, resolving the vars. */
function applyTheme(colors: Record<string, string>): void {
  const root = document.documentElement;
  for (const [name, fallback] of Object.entries(FALLBACK_PALETTE)) {
    const sourceKey = SYNTHESIZED[name] ?? name.replace(/^--vscode-/, "").replace(/-/g, ".");
    root.style.setProperty(name, colors[sourceKey] ?? fallback);
  }
}

async function loadAndApply(): Promise<void> {
  // 1. The developer's active VS Code theme, served by the dev server.
  try {
    applyTheme(await fetchThemeJson("/__sa-theme.json"));
    return;
  } catch {
    // Fall through to the VS Code defaults.
  }
  // 2. VS Code's default themes by OS color scheme (offline-safe).
  const isLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  try {
    applyTheme(await fetchThemeJson(isLight ? GITHUB_THEME_URLS.light : GITHUB_THEME_URLS.dark));
    return;
  } catch (err) {
    console.warn("[devTheme] fell back to the default palette:", err);
  }
  // 3. Neutral palette.
  applyTheme({});
}

// Apply the fallback immediately (first paint), then the real theme.
applyTheme({});
void loadAndApply();
