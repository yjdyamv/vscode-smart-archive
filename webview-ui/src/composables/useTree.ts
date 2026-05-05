import { ref, computed, type Ref } from "vue";
import type { TreeNodeData } from "../types";
import { saveState, loadState } from "./useMessage";

export interface FlatNode {
  node: TreeNodeData;
  depth: number;
  path: string;
  expanded: boolean;
  hasChildren: boolean;
  visible: boolean;
  inheritCollapsed: boolean;
}

function persistExpanded(paths: Set<string>): void {
  saveState({ expanded: [...paths] });
}

function loadExpanded(): Set<string> {
  const state = loadState<{ expanded?: string[] }>();
  return new Set(state?.expanded ?? []);
}

export function useTreeFlatten(treeData: Ref<TreeNodeData[]>) {
  const expandedPaths = ref(new Set<string>());
  const loadingPaths = ref(new Set<string>());

  function initExpandedFromTree(maxDepth = 2) {
    const saved = loadState<{ expanded?: string[] }>();
    if (saved?.expanded?.length) {
      expandedPaths.value = new Set(saved.expanded);
    } else {
      // Auto-expand non-collapsed directories up to maxDepth levels deep
      const paths: string[] = [];
      function collect(nodes: TreeNodeData[], depth: number) {
        if (depth > maxDepth) return;
        for (const node of nodes) {
          const hasKids = (node.children?.length ?? 0) > 0 || node.hasMore;
          if (node.kind === "DIRECTORY" && !node.collapsed && hasKids) {
            paths.push(node.path);
            if (node.children) collect(node.children, depth + 1);
          }
        }
      }
      collect(treeData.value, 0);
      expandedPaths.value = new Set(paths);
    }
  }

  const flatNodes = computed<FlatNode[]>(() => {
    const result: FlatNode[] = [];
    function walk(nodes: TreeNodeData[], depth: number, inheritCollapsed: boolean) {
      for (const node of nodes) {
        const hasKids = !!(node.kind === "DIRECTORY"
          && ((node.children && node.children.length > 0) || node.hasMore));
        const exp = expandedPaths.value.has(node.path);
        const isCollapsed = !!node.collapsed || inheritCollapsed;
        result.push({
          node,
          depth,
          path: node.path,
          expanded: exp,
          hasChildren: hasKids,
          visible: true,
          inheritCollapsed: isCollapsed,
        });
        if (hasKids && exp && node.children) {
          walk(node.children, depth + 1, isCollapsed);
        }
      }
    }
    walk(treeData.value, 0, false);
    return result;
  });

  function toggleExpand(path: string): void {
    if (expandedPaths.value.has(path)) {
      expandedPaths.value.delete(path);
    } else {
      expandedPaths.value.add(path);
    }
    persistExpanded(expandedPaths.value);
  }

  function expandAll(): void {
    function collect(nodes: TreeNodeData[]) {
      for (const node of nodes) {
        const hasKids = !!(node.kind === "DIRECTORY"
          && ((node.children && node.children.length > 0) || node.hasMore));
        if (hasKids) {
          expandedPaths.value.add(node.path);
          if (node.children) collect(node.children);
        }
      }
    }
    collect(treeData.value);
    persistExpanded(expandedPaths.value);
  }

  function collapseAll(): void {
    expandedPaths.value.clear();
    persistExpanded(expandedPaths.value);
  }

  function expandTo(path: string): void {
    const parts = path.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? prefix + "/" + parts[i] : parts[i];
      expandedPaths.value.add(prefix);
    }
  }

  function findNode(nodes: TreeNodeData[], path: string): TreeNodeData | null {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findNode(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }

  function insertChildren(parentPath: string, children: TreeNodeData[]): string[] {
    const node = findNode(treeData.value, parentPath);
    if (!node) return [];
    node.children = children;
    node.hasMore = false;
    loadingPaths.value.delete(parentPath);
    // re-trigger reactivity
    treeData.value = [...treeData.value];

    // Expand non-collapsed child directories (auto-expansion policy)
    const childPaths: string[] = [];
    for (const child of children) {
      childPaths.push(child.path);
      const hasKids = (child.children?.length ?? 0) > 0 || child.hasMore;
      if (child.kind === "DIRECTORY" && !child.collapsed && hasKids) {
        expandedPaths.value.add(child.path);
      }
    }
    persistExpanded(expandedPaths.value);
    return childPaths;
  }

  function getPathsNeedingLoad(): string[] {
    const result: string[] = [];
    function walk(nodes: TreeNodeData[]) {
      for (const node of nodes) {
        if (node.hasMore && (!node.children || node.children.length === 0)
          && expandedPaths.value.has(node.path)) {
          result.push(node.path);
        }
        if (node.children) walk(node.children);
      }
    }
    walk(treeData.value);
    return result;
  }

  function setLoading(path: string): void {
    loadingPaths.value.add(path);
  }

  function isLoading(path: string): boolean {
    return loadingPaths.value.has(path);
  }

  return {
    expandedPaths,
    loadingPaths,
    flatNodes,
    toggleExpand,
    expandAll,
    collapseAll,
    expandTo,
    findNode,
    insertChildren,
    getPathsNeedingLoad,
    initExpandedFromTree,
    setLoading,
    isLoading,
  };
}
