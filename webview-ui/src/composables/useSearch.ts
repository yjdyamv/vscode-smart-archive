import { ref } from "vue";
import type { TreeNodeData } from "../types";
import { MAX_REGEX_LENGTH } from "../constants";

// Patterns with nested quantifiers or excessive repetition are potential ReDoS vectors
const REDOS_PATTERNS = [
  /\((?!\?[:!=]).*\)(\+|\*|\{\d+,\})\s*(\+|\*|\{\d+,\})/, // nested quantifiers
  /(\+|\*)\s*(\+|\*)/, // consecutive quantifiers
  /\(\.\*\)\s*(\+|\*)/, // (.+)+ or (.\*)\* patterns
  /\\[bBdwWsSD]?\+\s*\+/, // a++ patterns
];

export function isRedosSafe(pattern: string): boolean {
  for (const re of REDOS_PATTERNS) {
    if (re.test(pattern)) return false;
  }
  if (pattern.length > MAX_REGEX_LENGTH) return false;
  return true;
}

export function fuzzyMatch(s: string, q: string): boolean {
  let qi = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function collectMatches(
  nodes: TreeNodeData[],
  re: RegExp | null,
  fuzzy: string | null,
  out: Set<string>,
  directOut: Set<string>,
): boolean {
  let any = false;
  for (const node of nodes) {
    let hit = false;
    if (re) {
      hit = re.test(node.name) || re.test(node.path);
    } else if (fuzzy) {
      hit =
        fuzzyMatch(node.name.toLowerCase(), fuzzy) || fuzzyMatch(node.path.toLowerCase(), fuzzy);
    }
    if (hit) {
      directOut.add(node.path);
      out.add(node.path);
      any = true;
    }
    if (node.children && node.children.length > 0) {
      const childHit = collectMatches(node.children, re, fuzzy, out, directOut);
      if (childHit) {
        out.add(node.path);
        any = true;
      }
    }
  }
  return any;
}

export function useSearch() {
  const query = ref("");
  const isRegex = ref(false);
  const matchSet = ref(new Set<string>());
  const directMatchSet = ref(new Set<string>());
  const regexError = ref("");

  function updateSearch(q: string, nodes: TreeNodeData[]): void {
    query.value = q;
    regexError.value = "";
    const raw = q.trim();
    const matched = new Set<string>();
    const directMatched = new Set<string>();

    if (!raw) {
      matchSet.value = matched;
      directMatchSet.value = directMatched;
      return;
    }

    if (isRegex.value) {
      try {
        if (!isRedosSafe(raw)) {
          regexError.value = "Pattern may be unsafe (avoid nested quantifiers like (a+)+)";
          return;
        }
        const re = new RegExp(raw, "i");
        collectMatches(nodes, re, null, matched, directMatched);
      } catch (e) {
        regexError.value = (e as Error).message;
      }
    } else {
      const lower = raw.toLowerCase();
      collectMatches(nodes, null, lower, matched, directMatched);
    }

    matchSet.value = matched;
    directMatchSet.value = directMatched;
  }

  function isVisible(path: string): boolean {
    if (!query.value.trim()) return true;
    return matchSet.value.has(path);
  }

  function toggleRegex(nodes: TreeNodeData[]): void {
    isRegex.value = !isRegex.value;
    regexError.value = "";
    if (query.value.trim()) {
      updateSearch(query.value, nodes);
    }
  }

  function clearSearch(): void {
    query.value = "";
    isRegex.value = false;
    regexError.value = "";
    matchSet.value.clear();
    directMatchSet.value.clear();
  }

  return {
    query,
    isRegex,
    regexError,
    matchSet,
    directMatchSet,
    updateSearch,
    isVisible,
    toggleRegex,
    clearSearch,
  };
}
