import { ref } from "vue";
import type { TreeNodeData } from "../types";

export type SortKey = "name" | "size";

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

  function cloneNode(node: TreeNodeData): TreeNodeData {
    return {
      ...node,
      children: node.children ? node.children.map(cloneNode) : undefined,
    };
  }

  function sortNodes(nodes: TreeNodeData[]): TreeNodeData[] {
    const sorted = [...nodes].sort((a, b) => {
      const aIsDir = a.kind === "DIRECTORY" ? 0 : 1;
      const bIsDir = b.kind === "DIRECTORY" ? 0 : 1;
      if (aIsDir !== bIsDir) return aIsDir - bIsDir;

      let cmp: number;
      if (sortKey.value === "size") {
        cmp = (a.size || 0) - (b.size || 0);
      } else {
        cmp = a.name.localeCompare(b.name);
      }
      return sortAsc.value ? cmp : -cmp;
    });

    const result: TreeNodeData[] = [];
    for (const node of sorted) {
      const cloned = cloneNode(node);
      if (cloned.children && cloned.children.length > 0) {
        cloned.children = sortNodes(cloned.children);
      }
      result.push(cloned);
    }
    return result;
  }

  return { sortKey, sortAsc, setSort, sortNodes };
}
