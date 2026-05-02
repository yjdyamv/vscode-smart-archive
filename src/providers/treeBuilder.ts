/**
 * Tree builder — Smart Archive VSCode Extension
 *
 * Converts a flat archive entry list into a hierarchical TreeNode[] tree.
 * Supports both full-tree builds and lazy (root-only + on-demand children).
 *
 * @module providers/treeBuilder
 */

interface TreeNode {
  name: string;
  path: string;
  size: number;
  kind: string;
  children?: TreeNode[];
  hasMore?: boolean;
}

type FlatEntry = { path: string; size: number; type: string };

interface EntryWithParts {
  entry: FlatEntry;
  parts: string[];
}

// ── Helpers ───────────────────────────────────────────────────────

function normalizeEntries(entries: FlatEntry[], archiveName: string): EntryWithParts[] {
  const normed: EntryWithParts[] = [];
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] === archiveName) continue;
    normed.push({ entry: e, parts });
  }
  return normed;
}

function sortEntries(items: EntryWithParts[]): void {
  items.sort((a, b) => {
    const aD = a.entry.type !== "REGULAR_FILE" ? 0 : 1;
    const bD = b.entry.type !== "REGULAR_FILE" ? 0 : 1;
    if (aD !== bD) return aD - bD;
    return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
  });
}

function mkdirNode(name: string, path: string, hasMore: boolean): TreeNode {
  return { name, path, size: 0, kind: "DIRECTORY", children: [], hasMore };
}

function mknondirNode(name: string, path: string, size: number): TreeNode {
  return { name, path, size, kind: "REGULAR_FILE" };
}

// ── Full-tree build (existing, optimized) ─────────────────────────

function buildTree(entries: FlatEntry[], archiveName: string): TreeNode[] {
  const normed = normalizeEntries(entries, archiveName);
  sortEntries(normed);

  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();
  const siblingMap = new Map<string, number>(); // avoids O(n) findIndex

  for (const { entry, parts } of normed) {
    let siblings = root;
    let prefix = "";

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const last = i === parts.length - 1;
      const full = prefix ? prefix + "/" + seg : seg;

      if (last) {
        if (seg === ".smartarchive") continue;
        const isDir = entry.type !== "REGULAR_FILE";
        const existing = dirMap.get(full);
        if (existing && existing.kind === "DIRECTORY") {
          existing.size = entry.size || existing.size;
          existing.hasMore = !!(existing.children && existing.children.length > 0);
        } else {
          const node: TreeNode = isDir
            ? { name: seg, path: entry.path, size: entry.size, kind: "DIRECTORY", children: [], hasMore: false }
            : { name: seg, path: entry.path, size: entry.size, kind: "REGULAR_FILE" };
          siblings.push(node);
          if (isDir) dirMap.set(full, node);
        }
      } else {
        let dir = dirMap.get(full);
        if (!dir) {
          // replace a file node with the same name by a dir node
          const dup = siblingMap.get(seg);
          if (dup !== undefined && siblings[dup]?.kind !== "DIRECTORY") {
            siblings.splice(dup, 1);
            siblingMap.delete(seg);
          }
          dir = mkdirNode(seg, full, false);
          siblingMap.set(seg, siblings.length);
          siblings.push(dir);
          dirMap.set(full, dir);
        }
        siblings = dir.children!;
        prefix = full;
      }
    }
  }

  // Post-pass: set hasMore on directories that have non-empty children
  for (const dir of dirMap.values()) {
    dir.hasMore = !!(dir.children && dir.children.length > 0);
  }

  return root;
}

// ── Lazy: root-only build ─────────────────────────────────────────

function buildTreeRootOnly(entries: FlatEntry[], archiveName: string): TreeNode[] {
  const normed = normalizeEntries(entries, archiveName);
  sortEntries(normed);

  const root: TreeNode[] = [];
  const seen = new Map<string, TreeNode>();
  const dirHasChildren = new Set<string>();

  // First pass: detect which directories have children
  for (const { parts } of normed) {
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join("/");
      dirHasChildren.add(prefix);
    }
  }

  for (const { entry, parts } of normed) {
    const seg = parts[0];
    if (seg === ".smartarchive") continue;

    const existing = seen.get(seg);
    if (existing) {
      if (existing.kind === "DIRECTORY" && entry.type !== "REGULAR_FILE") {
        existing.size = entry.size || existing.size;
      }
      continue;
    }

    const isDir = entry.type !== "REGULAR_FILE";
    const fullPath = entry.path;
    const fullSegPath = seg; // root-level path
    const hasKids = dirHasChildren.has(fullSegPath);

    const node: TreeNode = isDir
      ? mkdirNode(seg, isDir ? fullSegPath : fullPath, hasKids)
      : mknondirNode(seg, fullPath, entry.size);

    root.push(node);
    seen.set(seg, node);
  }

  return root;
}

// ── Lazy: get children of a specific directory ────────────────────

function getDirChildren(
  entries: FlatEntry[],
  parentPath: string,
): TreeNode[] {
  const prefix = parentPath + "/";
  const dirHasChildren = new Set<string>();
  const children: TreeNode[] = [];
  const seen = new Map<string, TreeNode>();

  // Collect all entries under the parent
  const candidates: EntryWithParts[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const relative = e.path.slice(prefix.length);
    if (!relative) continue;
    const parts = relative.split("/");
    if (parts.length === 0) continue;
    candidates.push({ entry: e, parts });
  }

  // Detect which sub-directories have further children
  for (const { parts } of candidates) {
    if (parts.length > 1) {
      dirHasChildren.add(parts[0]);
    }
  }

  sortEntries(candidates);

  for (const { entry, parts } of candidates) {
    const seg = parts[0];
    if (seg === ".smartarchive") continue;

    const isDir = entry.type !== "REGULAR_FILE";
    const fullChildPath = prefix + seg;
    const hasKids = dirHasChildren.has(seg);

    const existing = seen.get(seg);
    if (existing) {
      if (existing.kind === "DIRECTORY" && isDir) {
        existing.size = entry.size || existing.size;
      }
      continue;
    }

    const node: TreeNode = isDir
      ? mkdirNode(seg, fullChildPath, hasKids)
      : { name: seg, path: fullChildPath, size: entry.size, kind: "REGULAR_FILE" };

    children.push(node);
    seen.set(seg, node);
  }

  return children;
}

// ── Stats helpers ──────────────────────────────────────────────────

function countFlatStats(entries: FlatEntry[]): { files: number; dirs: number; total: number; totalSize: number } {
  let files = 0;
  let dirs = 0;
  let totalSize = 0;
  for (const e of entries) {
    totalSize += e.size || 0;
    if (e.type !== "REGULAR_FILE") dirs++;
    else files++;
  }
  return { files, dirs, total: files + dirs, totalSize };
}

function countTreeStats(nodes: TreeNode[]): { files: number; dirs: number; total: number } {
  let files = 0;
  let dirs = 0;
  for (const node of nodes) {
    if (node.kind === "DIRECTORY") {
      dirs++;
      if (node.children && node.children.length > 0) {
        const child = countTreeStats(node.children);
        files += child.files;
        dirs += child.dirs;
      }
    } else {
      files++;
    }
  }
  return { files, dirs, total: files + dirs };
}

export type { TreeNode, FlatEntry };
export { buildTree, buildTreeRootOnly, getDirChildren, countTreeStats, countFlatStats };
