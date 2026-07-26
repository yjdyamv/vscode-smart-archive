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

/** Discriminated union for all extension → webview messages. */
export type ExtensionMessage =
  | { c: "ok"; t: string }
  | { c: "err"; t: string }
  | { c: "pwerr"; t: string }
  | { c: "loading"; t: string | false }
  | { c: "dirChildren"; path: string; children: TreeNodeData[] }
  | { c: "encState"; v: boolean };
