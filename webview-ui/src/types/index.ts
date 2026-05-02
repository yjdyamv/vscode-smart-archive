export interface TreeNodeData {
  name: string;
  path: string;
  size: number;
  kind: "DIRECTORY" | "REGULAR_FILE";
  children?: TreeNodeData[];
  hasMore?: boolean;
}

export interface ArchiveProps {
  name: string;
  format: string;
  count: number;
  files: number;
  dirs: number;
  size: string;
}

export interface FileIcon {
  color: string;
  emoji: string;
}
