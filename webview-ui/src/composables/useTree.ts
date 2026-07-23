import { ref, computed, type Ref } from "vue";
import type { TreeNodeData, FlatNode } from "../types";
import { loadState } from "./useMessage";

export type { FlatNode };

export function buildNodeMap(nodes: TreeNodeData[]): Map<string, TreeNodeData> {
  const map = new Map<string, TreeNodeData>();
  function walk(ns: TreeNodeData[]) {
    for (const node of ns) {
      map.set(node.path, node);
      if (node.children) walk(node.children);
    }
  }
  walk(nodes);
  return map;
}

export function useTreeFlatten(treeData: Ref<TreeNodeData[]>) {
  const expandedPaths = ref(new Set<string>());
  const loadingPaths = ref(new Set<string>());
  // null = restore mode (respect persisted set), number = auto-expand depth limit
  const autoExpandMaxDepth = ref<number | null>(null);

  // O(1) path → node lookup, rebuilt only when treeData changes
  const nodeMap = computed(() => buildNodeMap(treeData.value));

  function findNodeFast(path: string): TreeNodeData | null {
    return nodeMap.value.get(path) ?? null;
  }

  function initExpandedFromTree(maxDepth = 2) {
    const saved = loadState<{ expanded?: string[] }>();
    if (saved?.expanded?.length) {
      expandedPaths.value = new Set(saved.expanded);
      autoExpandMaxDepth.value = null;
      for (const p of saved.expanded) {
        expandTo(p);
      }
      return;
    }
    const persistent = (window as any)._xExpanded as string[] | undefined;
    if (persistent?.length) {
      autoExpandMaxDepth.value = null;
      expandedPaths.value = new Set(persistent);
      for (const p of persistent) {
        expandTo(p);
      }
      return;
    }
    autoExpandMaxDepth.value = maxDepth;
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

  const flatNodes = computed<FlatNode[]>(() => {
    const result: FlatNode[] = [];
    function walk(nodes: TreeNodeData[], depth: number, inheritCollapsed: boolean) {
      for (const node of nodes) {
        const hasKids = !!(
          node.kind === "DIRECTORY" &&
          ((node.children && node.children.length > 0) || node.hasMore)
        );
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
  }

  function expandAll(): void {
    function collect(nodes: TreeNodeData[]) {
      for (const node of nodes) {
        if (node.collapsed) continue;
        const hasKids = !!(
          node.kind === "DIRECTORY" &&
          ((node.children && node.children.length > 0) || node.hasMore)
        );
        if (hasKids) {
          expandedPaths.value.add(node.path);
          if (node.children) collect(node.children);
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

  function insertChildren(parentPath: string, children: TreeNodeData[]): string[] {
    const node = findNodeFast(parentPath);
    if (!node) return [];
    node.children = children;
    node.hasMore = false;
    loadingPaths.value.delete(parentPath);
    treeData.value = [...treeData.value];

    const childPaths: string[] = [];
    for (const child of children) {
      childPaths.push(child.path);
    }
    return childPaths;
  }

  function getPathsNeedingLoad(): string[] {
    const result: string[] = [];
    function walk(nodes: TreeNodeData[]) {
      for (const node of nodes) {
        if (
          node.hasMore &&
          (!node.children || node.children.length === 0) &&
          expandedPaths.value.has(node.path) &&
          !loadingPaths.value.has(node.path)
        ) {
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

  function shouldAutoExpandChild(path: string): boolean {
    if (autoExpandMaxDepth.value === null) {
      return expandedPaths.value.has(path);
    }
    const depth = (path.match(/\//g) || []).length;
    return depth <= autoExpandMaxDepth.value;
  }

  return {
    expandedPaths,
    loadingPaths,
    flatNodes,
    nodeMap,
    toggleExpand,
    expandAll,
    collapseAll,
    expandTo,
    findNode: findNodeFast,
    insertChildren,
    getPathsNeedingLoad,
    initExpandedFromTree,
    setLoading,
    shouldAutoExpandChild,
  };
}
