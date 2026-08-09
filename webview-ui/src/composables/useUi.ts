/**
 * Webview UI strings — Smart Archive webview
 *
 * The host injects every user-visible string as the `_xStrings` JSON blob
 * (localized in src/i18n.ts — the single source). Components read through
 * useUi() so the webview never keeps a parallel translation table. The
 * English literals below are fallbacks only, for environments without the
 * injected blob (unit tests); production always has it.
 */

let strings: Record<string, string> = {};

export function setUiStrings(uiStrings: Record<string, string>): void {
  strings = uiStrings;
}

export function useUi(): Record<string, string> {
  return strings;
}

const FALLBACKS: Record<string, string> = {
  "ui.extract": "Extract",
  "ui.delete": "Delete",
  "ui.addFiles": "Add Files",
  "ui.addTo": "Add to ",
  "ui.archiveRoot": "archive root",
  "ui.extractAll": "Extract All",
  "ui.convert": "Convert",
  "ui.expandAll": "Expand All",
  "ui.collapseAll": "Collapse All",
  "ui.selFiles": "files",
  "ui.selDirs": "dirs",
  "ui.name": "Name",
  "ui.size": "Size",
  "ui.filter": "Filter…",
  "ui.regex": "Regex…",
  "ui.fuzzySearch": "Switch to fuzzy search",
  "ui.useRegex": "Use regular expression",
  "ui.merge": "Merge",
  "ui.mergeTitle": "Merge split volumes into a single archive",
  "ui.split": "Split",
  "ui.splitTitle": "Split into volumes",
  "ui.decrypt": "Decrypt",
  "ui.decryptTitle": "Remove encryption and re-pack",
  "ui.encrypt": "Encrypt",
  "ui.encryptTitle": "Add encryption to this archive",
  "ui.testTitle": "Test Archive Integrity",
  "ui.itemsLabel": "Items:",
  "ui.filesLabel": "Files:",
  "ui.dirsLabel": "Dirs:",
  "ui.sizeLabel": "Size:",
  "ui.ratioLabel": "Ratio:",
  "ui.encryptedHint": "This archive is encrypted. Enter its password to continue.",
  "ui.password": "Password",
  "ui.unlock": "Unlock",
  "ui.wrongPassword": "Wrong password — please try again",
  "ui.select": "Select ",
  "ui.collapse": "Collapse ",
  "ui.expand": "Expand ",
  "ui.readingArchive": "Reading archive...",
  "ui.failedToInit": "Failed to initialize archive view: ",
  "ui.noMatchingFiles": "No matching files",
  "ui.noMatchingHint": "Try adjusting your search terms or clear the query",
  "ui.noFiles": "No files to display",
  "ui.match": "match",
  "ui.matches": "matches",
  "ui.archive": "Archive",
};

/** Localized string with a fallback for missing blobs (tests / early boot). */
export function ui(key: string): string {
  return strings[key] ?? FALLBACKS[key] ?? key;
}
