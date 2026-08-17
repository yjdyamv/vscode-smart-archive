/** Shared UI constants — Smart Archiver webview */

/** JS fallback for --sa-row-multiplier (defined in tailwind.css) when CSS is unavailable */
export const ROW_HEIGHT_FALLBACK = 1.85;
/** Default font-size fallback when CSS variable is unavailable (px) */
export const DEFAULT_FONT_SIZE = 14;
/** Indent width per tree depth level (px) */
export const INDENT_PX = 16;
/** Virtualizer overscan count */
export const VIRTUAL_OVERSCAN = 10;

/** Toast auto-hide durations (ms) */
export const TOAST_SUCCESS_MS = 1800;
export const TOAST_ERROR_MS = 4000;
/** Search input debounce (ms) */
export const SEARCH_DEBOUNCE_MS = 150;
/** Selection persistence debounce (ms) */
export const SAVE_DEBOUNCE_MS = 300;
/** Password error auto-hide (ms) */
export const PW_ERROR_HIDE_MS = 4000;

/** Default page-size fallback when container is unavailable */
export const DEFAULT_PAGE_SIZE = 15;
/** Max regex pattern length for ReDoS safety */
export const MAX_REGEX_LENGTH = 200;
/** Default auto-expand tree depth */
export const DEFAULT_EXPAND_DEPTH = 2;
