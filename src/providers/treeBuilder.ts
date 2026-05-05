/**
 * Tree builder — Smart Archive VSCode Extension
 *
 * Converts a flat archive entry list into a hierarchical TreeNode[] tree.
 * Supports both full-tree builds and lazy (root-only + on-demand children).
 *
 * @module providers/treeBuilder
 */

import { minimatch } from "minimatch";
import { getSplitVolumeBase } from "../constants";

interface TreeNode {
  name: string;
  path: string;
  size: number;
  kind: string;
  children?: TreeNode[];
  hasMore?: boolean;
  collapsed?: boolean;
}

type FlatEntry = { path: string; size: number; type: string };

interface EntryWithParts {
  entry: FlatEntry;
  parts: string[];
}

// ── Helpers ───────────────────────────────────────────────────────

function normalizeEntries(entries: FlatEntry[], archiveName: string): EntryWithParts[] {
  const normed: EntryWithParts[] = [];
  const volBase = getSplitVolumeBase(archiveName);
  for (const e of entries) {
    let p = e.path.replace(/\\/g, "/");
    // Strip leading "./" (libarchive convention)
    if (p.startsWith("./")) p = p.slice(2);
    // Skip root self-reference entries
    if (!p || p === ".") continue;
    const parts = p.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    // Only skip non-directory self-references (e.g. libarchive lists the archive
    // itself as a file entry). Keep directory entries — they provide the root
    // structure for lazy-loaded trees.
    if (e.type === "REGULAR_FILE") {
      if (parts.length === 1 && parts[0] === archiveName) continue;
      if (volBase && parts.length === 1 && parts[0] === volBase) continue;
    }
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
            ? {
                name: seg,
                path: entry.path,
                size: entry.size,
                kind: "DIRECTORY",
                children: [],
                hasMore: false,
              }
            : { name: seg, path: entry.path, size: entry.size, kind: "REGULAR_FILE" };
          // Track in siblingMap so intermediate dirs from other entries can replace this file
          if (!isDir) siblingMap.set(seg, siblings.length);
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

  // buildNodes handles common-prefix directories natively via
  // implicitDir detection (parts.length > 1 → seg is a directory).
  const nodes = buildNodes(normed);

  // If all entries collapsed into a single directory node and its name
  // matches the archive name, show that dir instead of "nothing to see".
  if (
    nodes.length === 1 &&
    nodes[0].kind === "DIRECTORY" &&
    nodes[0].name === archiveName &&
    nodes[0].hasMore
  ) {
    return nodes;
  }

  return nodes;
}

function buildNodes(normed: EntryWithParts[]): TreeNode[] {
  const root: TreeNode[] = [];
  const seen = new Map<string, TreeNode>();
  const dirHasChildren = new Set<string>();

  for (const { parts } of normed) {
    for (let i = 0; i < parts.length - 1; i++) {
      dirHasChildren.add(parts.slice(0, i + 1).join("/"));
    }
  }

  for (const { entry, parts } of normed) {
    let seg = parts[0];
    if (!seg || seg === ".smartarchive") continue;

    const implicitDir = parts.length > 1;

    let existing = seen.get(seg);
    if (
      existing &&
      existing.kind !== "DIRECTORY" &&
      (implicitDir || entry.type !== "REGULAR_FILE")
    ) {
      existing.kind = "DIRECTORY";
      existing.children = [];
      existing.path = seg;
      existing.hasMore = dirHasChildren.has(seg);
    }

    if (existing) {
      if (existing.kind === "DIRECTORY") {
        if (entry.type !== "REGULAR_FILE") {
          existing.size = entry.size || existing.size;
        }
        continue;
      }
      continue;
    }

    const hasKids = dirHasChildren.has(seg);
    const isDir = entry.type !== "REGULAR_FILE" || implicitDir || hasKids;
    const node: TreeNode = isDir
      ? mkdirNode(seg, seg, hasKids)
      : mknondirNode(seg, seg, entry.size);

    root.push(node);
    seen.set(seg, node);
  }

  return root;
}

// ── Entry index (fast child lookup) ────────────────────────────────

type EntryIndex = Map<string, FlatEntry[]>;

function buildEntryIndex(entries: FlatEntry[]): EntryIndex {
  const index: EntryIndex = new Map();
  index.set("", []); // root
  for (const e of entries) {
    let p = e.path.replace(/\\/g, "/");
    if (p.startsWith("./")) p = p.slice(2);
    // Strip trailing slash so directory entries index under their parent
    if (p.endsWith("/")) p = p.slice(0, -1);
    const lastSlash = p.lastIndexOf("/");
    const parent = lastSlash > 0 ? p.slice(0, lastSlash) : "";
    let bucket = index.get(parent);
    if (!bucket) {
      bucket = [];
      index.set(parent, bucket);
    }
    bucket.push(e);
  }
  return index;
}

// ── Lazy: get children of a specific directory ────────────────────

function getDirChildren(parentPath: string, entries: FlatEntry[], index?: EntryIndex): TreeNode[] {
  let candidates: EntryWithParts[];

  if (index) {
    const bucket = index.get(parentPath);
    if (!bucket) return [];
    candidates = bucket
      .filter((e) => {
        let p = e.path.replace(/\\/g, "/");
        if (p.startsWith("./")) p = p.slice(2);
        // Skip the directory's own entry (e.g. "subdir/" when expanding "subdir")
        if (p === parentPath || p === parentPath + "/") return false;
        return true;
      })
      .map((e) => {
        let p = e.path.replace(/\\/g, "/");
        if (p.startsWith("./")) p = p.slice(2);
        const relative = p.slice(parentPath ? parentPath.length + 1 : 0);
        return { entry: e, parts: relative.split("/").filter(Boolean) };
      });
  } else {
    const prefix = parentPath ? parentPath + "/" : "";
    candidates = [];
    for (const e of entries) {
      const p = e.path.replace(/\\/g, "/");
      if (!p.startsWith(prefix)) continue;
      const relative = p.slice(prefix.length);
      if (!relative) continue;
      const parts = relative.split("/");
      if (parts.length === 0) continue;
      candidates.push({ entry: e, parts });
    }
  }

  // Detect which sub-directories have further children
  const dirHasChildren = new Set<string>();
  const children: TreeNode[] = [];
  const seen = new Map<string, TreeNode>();

  for (const { parts } of candidates) {
    if (parts.length > 1) {
      dirHasChildren.add(parts[0]);
    }
  }

  sortEntries(candidates);

  for (const { entry, parts } of candidates) {
    const seg = parts[0];
    if (seg === ".smartarchive") continue;

    const fullChildPath = parentPath ? parentPath + "/" + seg : seg;
    const hasKids =
      dirHasChildren.has(seg) || (index ? (index.get(fullChildPath)?.length ?? 0) > 0 : false);

    const existing = seen.get(seg);
    const implicitDir = parts.length > 1;

    // Upgrade existing file to directory if sub-entries prove it's a dir
    if (
      existing &&
      existing.kind !== "DIRECTORY" &&
      (implicitDir || entry.type !== "REGULAR_FILE")
    ) {
      existing.kind = "DIRECTORY";
      existing.children = [];
      existing.path = fullChildPath;
      existing.hasMore = hasKids;
    }

    if (existing) {
      if (existing.kind === "DIRECTORY") {
        if (entry.type !== "REGULAR_FILE") {
          existing.size = entry.size || existing.size;
        }
        continue;
      }
      continue;
    }

    const isDir = entry.type !== "REGULAR_FILE" || implicitDir || hasKids;
    const node: TreeNode = isDir
      ? mkdirNode(seg, fullChildPath, hasKids)
      : { name: seg, path: fullChildPath, size: entry.size, kind: "REGULAR_FILE" };

    children.push(node);
    seen.set(seg, node);
  }

  return children;
}

// ── Noisy directory marking ────────────────────────────────────────

function markNoisyDirs(nodes: TreeNode[], noisyPatterns: string[]): void {
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
      }
    }
    if (node.children) markNoisyDirs(node.children, noisyPatterns);
  }
}

// ── Stats helpers ──────────────────────────────────────────────────

function countAllStats(entries: FlatEntry[]): {
  files: number;
  dirs: number;
  total: number;
  totalSize: number;
} {
  // First pass: collect all implicit directories from path prefixes
  const dirSet = new Set<string>();
  for (const e of entries) {
    const p = e.path.replace(/\\/g, "/");
    // Collect all parent segments as implicit dirs
    let i = p.indexOf("/");
    while (i !== -1) {
      if (i > 0) dirSet.add(p.slice(0, i));
      i = p.indexOf("/", i + 1);
    }
    // Explicit directory entries are also dirs
    if (e.type !== "REGULAR_FILE") dirSet.add(p);
  }

  // Second pass: count files (entries NOT in dirSet) and compute totalSize
  let files = 0;
  let totalSize = 0;
  for (const e of entries) {
    totalSize += e.size || 0;
    const p = e.path.replace(/\\/g, "/");
    if (!dirSet.has(p)) files++;
  }

  return { files, dirs: dirSet.size, total: files + dirSet.size, totalSize };
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

export type { TreeNode, FlatEntry, EntryIndex };
export {
  buildTree,
  buildTreeRootOnly,
  getDirChildren,
  countTreeStats,
  buildEntryIndex,
  markNoisyDirs,
  countAllStats,
};
