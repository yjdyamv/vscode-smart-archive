import { ref } from "vue";
import type { TreeNodeData } from "../types";

export function useSearch() {
  const query = ref("");
  const isRegex = ref(false);
  const matchSet = ref(new Set<string>());

  function fuzzyMatch(s: string, q: string): boolean {
    let qi = 0;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) qi++;
    }
    return qi === q.length;
  }

  function updateSearch(q: string, nodes: TreeNodeData[]): void {
    query.value = q;
    const raw = q.trim();
    const matched = new Set<string>();

    if (raw.length > 2 && raw[0] === "/" && raw.lastIndexOf("/") === raw.length - 1) {
      isRegex.value = true;
      const pattern = raw.slice(1, -1);
      try {
        const re = new RegExp(pattern, "i");
        collectMatches(nodes, re, null, matched);
      } catch {
        isRegex.value = false;
      }
    } else if (raw) {
      isRegex.value = false;
      const lower = raw.toLowerCase();
      collectMatches(nodes, null, lower, matched);
    }

    matchSet.value = matched;
  }

  function collectMatches(
    nodes: TreeNodeData[],
    re: RegExp | null,
    fuzzy: string | null,
    out: Set<string>,
  ): boolean {
    let any = false;
    for (const node of nodes) {
      let hit = false;
      if (re) {
        hit = re.test(node.name) || re.test(node.path);
      } else if (fuzzy) {
        hit = fuzzyMatch(node.name.toLowerCase(), fuzzy) || fuzzyMatch(node.path.toLowerCase(), fuzzy);
      }
      if (hit) {
        out.add(node.path);
        any = true;
      }
      if (node.children && node.children.length > 0) {
        const childHit = collectMatches(node.children, re, fuzzy, out);
        if (childHit) {
          out.add(node.path);
          any = true;
        }
      }
    }
    return any;
  }

  function isVisible(path: string): boolean {
    if (!query.value.trim()) return true;
    return matchSet.value.has(path);
  }

  function clearSearch(): void {
    query.value = "";
    isRegex.value = false;
    matchSet.value.clear();
  }

  return { query, isRegex, updateSearch, isVisible, clearSearch, matchSet };
}
