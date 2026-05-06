import { ref, type Ref } from "vue";
import type { TreeNodeData } from "../types";

export type SortKey = "name" | "size";

export function useSort(_treeData: Ref<TreeNodeData[]>) {
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

    for (const node of sorted) {
      if (node.children && node.children.length > 0) {
        node.children = sortNodes(node.children);
      }
    }
    return sorted;
  }

  return { sortKey, sortAsc, setSort, sortNodes };
}
