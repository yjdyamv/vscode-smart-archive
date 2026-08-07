export interface TreeNodeData {
  name: string;
  path: string;
  size: number;
  kind: "DIRECTORY" | "REGULAR_FILE";
  children?: TreeNodeData[];
  hasMore?: boolean;
  collapsed?: boolean;
}

export interface FlatNode {
  node: TreeNodeData;
  depth: number;
  path: string;
  expanded: boolean;
  hasChildren: boolean;
  visible: boolean;
  inheritCollapsed: boolean;
}

export interface ArchiveProps {
  name: string;
  format: string;
  count: number;
  files: number;
  dirs: number;
  size: string;
  ratio: number;
}

export interface FileIcon {
  codicon: string;
}
