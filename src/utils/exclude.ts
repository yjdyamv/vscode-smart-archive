/**
 * Exclusion helpers — Smart Archive VSCode Extension
 *
 * Shared exclusion logic used by both the tar-writer (wrapped formats)
 * and the 7z compression path (non-wrapped formats).  Splits user-supplied
 * patterns into two categories so each code path can apply them consistently:
 *
 * 1. exactNames  – Set of literal file/directory names (fast O(1) look-up)
 * 2. globPatterns – patterns containing wildcards (delegated to minimatch)
 *
 * @module utils/exclude
 */

import * as path from "path";
import { minimatch } from "minimatch";

const GLOB_RE = /[*?[\]{}]/;

export interface ExclusionSet {
  exactNames: ReadonlySet<string>;
  globPatterns: readonly string[];
}

export function prepareExclusions(patterns: string[]): ExclusionSet {
  const exactNames = new Set<string>();
  const globPatterns: string[] = [];
  for (const raw of patterns) {
    const stripped = raw.replace(/^(\*\*\/)+/, "");
    if (!stripped) continue;
    if (GLOB_RE.test(stripped)) {
      globPatterns.push(raw);
    } else {
      exactNames.add(stripped);
    }
  }
  return { exactNames, globPatterns };
}

export function isPathExcluded(relPath: string, exclusions: ExclusionSet): boolean {
  const { exactNames, globPatterns } = exclusions;
  if (exactNames.size === 0 && globPatterns.length === 0) return false;

  const segments = relPath.replace(/\\/g, "/").split("/");
  for (const seg of segments) {
    if (seg && exactNames.has(seg)) return true;
  }
  for (const p of globPatterns) {
    if (minimatch(relPath, p, { dot: true, matchBase: true })) return true;
  }
  return false;
}

export function isTargetExcluded(fullPath: string, exclusions: ExclusionSet): boolean {
  return isPathExcluded(path.basename(fullPath), exclusions);
}
