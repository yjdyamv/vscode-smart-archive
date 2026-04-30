/**
 * Tree builder — Smart Archive VSCode Extension
 *
 * Converts a flat archive entry list into a hierarchical TreeNode[] tree
 * suitable for rendering in the archive webview.
 *
 * @module providers/treeBuilder
 */

interface TreeNode {
  name: string;
  path: string;
  size: number;
  kind: string;
  children?: TreeNode[];
}

function buildTree(
  entries: { path: string; size: number; type: string }[],
  archiveName: string,
): TreeNode[] {
  interface EntryWithParts {
    entry: (typeof entries)[0];
    parts: string[];
  }
  const normed: EntryWithParts[] = [];
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] === archiveName) continue;
    normed.push({ entry: e, parts });
  }

  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  normed.sort((a, b) => {
    const aD = a.entry.type !== "REGULAR_FILE" ? 0 : 1;
    const bD = b.entry.type !== "REGULAR_FILE" ? 0 : 1;
    if (aD !== bD) return aD - bD;
    return a.entry.path.localeCompare(b.entry.path);
  });

  for (const { entry, parts } of normed) {
    let siblings = root;
    let prefix = "";

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const last = i === parts.length - 1;
      const full = prefix ? prefix + "/" + seg : seg;

      if (last) {
        const isDir = entry.type !== "REGULAR_FILE";
        const existing = dirMap.get(full);
        if (existing && existing.kind === "DIRECTORY") {
          existing.size = entry.size || existing.size;
        } else {
          const node: TreeNode = {
            name: seg,
            path: entry.path,
            size: entry.size,
            kind: isDir ? "DIRECTORY" : "REGULAR_FILE",
            children: isDir ? [] : undefined,
          };
          siblings.push(node);
          if (isDir) dirMap.set(full, node);
        }
      } else {
        let dir = dirMap.get(full);
        if (!dir) {
          const dup = siblings.findIndex((s) => s.name === seg && s.kind !== "DIRECTORY");
          if (dup >= 0) siblings.splice(dup, 1);
          dir = { name: seg, path: full, size: 0, kind: "DIRECTORY", children: [] };
          siblings.push(dir);
          dirMap.set(full, dir);
        }
        siblings = dir.children!;
        prefix = full;
      }
    }
  }

  if (root.length === 1 && root[0].kind === "DIRECTORY" && root[0].children) {
    return root[0].children;
  }
  return root;
}

export type { TreeNode };
export { buildTree };
