import { DEFAULT_FONT_SIZE, ROW_HEIGHT_FALLBACK } from "../constants";

/** Resolve the effective font size, falling back to the VS Code default. */
export function resolveFontSize(): number {
  const cs = getComputedStyle(document.documentElement);
  return (
    parseFloat(cs.getPropertyValue("--vscode-font-size")) ||
    parseFloat(cs.fontSize) ||
    DEFAULT_FONT_SIZE
  );
}

/** Row height used by the virtualizer — same multiplier CSS uses. */
export function resolveRowHeight(): number {
  const cs = getComputedStyle(document.documentElement);
  const mult = parseFloat(cs.getPropertyValue("--sa-row-multiplier")) || ROW_HEIGHT_FALLBACK;
  return resolveFontSize() * mult;
}
