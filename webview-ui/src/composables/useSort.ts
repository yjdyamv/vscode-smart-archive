import { ref } from "vue";
import type { TreeNodeData } from "../types";
import type { DescCount } from "../bootstrap";

export type SortKey = "name" | "size";

function cloneNode(node: TreeNodeData): TreeNodeData {
  return {
    ...node,
    children: node.children ? node.children.map(cloneNode) : undefined,
  };
}

/** Effective size for sorting: a directory's own size is the aggregate of
 * its contents (descCounts), which the archive listing does not store on
 * the node itself. */
function sortableSize(node: TreeNodeData, descCounts: Record<string, DescCount>): number {
  if (node.kind === "DIRECTORY") return descCounts[node.path]?.size ?? 0;
  return node.size || 0;
}

export function useSort() {
  const sortKey = ref<SortKey>("name");
  const sortAsc = ref(true);

  function setSort(key: SortKey): void {
    if (sortKey.value === key) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortKey.value = key;
      sortAsc.value = true;
    }
  }

  function sortNodes(
    nodes: TreeNodeData[],
    descCounts: Record<string, DescCount> = {},
  ): TreeNodeData[] {
    const sorted = [...nodes].sort((a, b) => {
      // Invariant: folders always stay above files at the same level,
      // whichever sort key is active.
      const aIsDir = a.kind === "DIRECTORY" ? 0 : 1;
      const bIsDir = b.kind === "DIRECTORY" ? 0 : 1;
      if (aIsDir !== bIsDir) return aIsDir - bIsDir;

      let cmp: number;
      if (sortKey.value === "size") {
        // Folders sort by their aggregate size (descCounts), not the 0 the
        // listing stores on the node; files by their own size.
        cmp = sortableSize(a, descCounts) - sortableSize(b, descCounts);
      } else {
        cmp = a.name.localeCompare(b.name);
      }
      return sortAsc.value ? cmp : -cmp;
    });

    const result: TreeNodeData[] = [];
    for (const node of sorted) {
      const cloned = cloneNode(node);
      if (cloned.children && cloned.children.length > 0) {
        cloned.children = sortNodes(cloned.children, descCounts);
      }
      result.push(cloned);
    }
    return result;
  }

  return { sortKey, sortAsc, setSort, sortNodes };
}
