/**
 * Noisy directory pattern matching — Smart Archive VSCode Extension
 *
 * Marks directory tree nodes as collapsed when they match user-configured
 * "noisy" patterns (node_modules, .git, etc.). Extracted to a pure module
 * so tests can import it without pulling in the VS Code extension API.
 *
 * @module utils/noisy-patterns
 */

import { minimatch } from "minimatch";

interface TreeNode {
  name: string;
  path: string;
  size: number;
  kind: string;
  children?: TreeNode[];
  hasMore?: boolean;
  collapsed?: boolean;
}

export function markNoisyDirs(nodes: TreeNode[], noisyPatterns: string[]): void {
  if (noisyPatterns.length === 0) return;
  for (const node of nodes) {
    if (node.kind === "DIRECTORY") {
      for (const pattern of noisyPatterns) {
        if (
          minimatch(node.path, pattern, { dot: true }) ||
          minimatch(node.name, pattern, { dot: true })
        ) {
          node.collapsed = true;
          break;
        }
        // Also collapse if any ancestor segment matches (e.g. node_modules/express
        // is a child of node_modules and should not auto-expand)
        for (const seg of node.path.split("/")) {
          if (minimatch(seg, pattern, { dot: true })) {
            node.collapsed = true;
            break;
          }
        }
        if (node.collapsed) break;
      }
    }
    if (node.children) markNoisyDirs(node.children, noisyPatterns);
  }
}
