import { ref, computed, type Ref } from "vue";
import type { TreeNodeData } from "../types";

export interface FlatNode {
  node: TreeNodeData;
  depth: number;
  path: string;
  expanded: boolean;
  hasChildren: boolean;
  visible: boolean;
}

export function useTreeFlatten(treeData: Ref<TreeNodeData[]>) {
  const expandedPaths = ref(new Set<string>());

  const flatNodes = computed<FlatNode[]>(() => {
    const result: FlatNode[] = [];
    function walk(nodes: TreeNodeData[], depth: number) {
      for (const node of nodes) {
        const hasKids = !!(node.kind === "DIRECTORY" && node.children && node.children.length > 0);
        const exp = expandedPaths.value.has(node.path);
        result.push({
          node,
          depth,
          path: node.path,
          expanded: exp,
          hasChildren: hasKids,
          visible: true,
        });
        if (hasKids && exp && node.children) {
          walk(node.children, depth + 1);
        }
      }
    }
    walk(treeData.value, 0);
    return result;
  });

  function toggleExpand(path: string): void {
    if (expandedPaths.value.has(path)) {
      expandedPaths.value.delete(path);
    } else {
      expandedPaths.value.add(path);
    }
  }

  function expandAll(): void {
    function collect(nodes: TreeNodeData[]) {
      for (const node of nodes) {
        if (node.kind === "DIRECTORY" && node.children && node.children.length > 0) {
          expandedPaths.value.add(node.path);
          collect(node.children);
        }
      }
    }
    collect(treeData.value);
  }

  function collapseAll(): void {
    expandedPaths.value.clear();
  }

  function expandTo(path: string): void {
    const parts = path.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? prefix + "/" + parts[i] : parts[i];
      expandedPaths.value.add(prefix);
    }
  }

  function flatNodesToTree(): TreeNodeData[] {
    return treeData.value;
  }

  return {
    expandedPaths,
    flatNodes,
    toggleExpand,
    expandAll,
    collapseAll,
    expandTo,
    flatNodesToTree,
  };
}
