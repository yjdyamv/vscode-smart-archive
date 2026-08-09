/**
 * Tree builder — Smart Archive VSCode Extension
 *
 * Converts a flat archive entry list into a hierarchical TreeNode[] tree.
 * Supports both full-tree builds and lazy (root-only + on-demand children).
 *
 * @module providers/treeBuilder
 */

import { getSplitVolumeBase } from "../constants";
import { markNoisyDirs } from "../utils/noisy-patterns";

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

// ── Lazy: root-only build ─────────────────────────────────────────

function buildTreeRootOnly(entries: FlatEntry[], archiveName: string): TreeNode[] {
  const normed = normalizeEntries(entries, archiveName);
  sortEntries(normed);

  // buildNodes handles common-prefix directories natively via
  // implicitDir detection (parts.length > 1 → seg is a directory).
  return buildNodes(normed);
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
    candidates = bucket
      ? bucket
          .filter((e) => {
            let p = e.path.replace(/\\/g, "/");
            if (p.startsWith("./")) p = p.slice(2);
            if (p === parentPath || p === parentPath + "/") return false;
            return true;
          })
          .map((e) => {
            let p = e.path.replace(/\\/g, "/");
            if (p.startsWith("./")) p = p.slice(2);
            const relative = p.slice(parentPath ? parentPath.length + 1 : 0);
            return { entry: e, parts: relative.split("/").filter(Boolean) };
          })
      : [];
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
    const node = isDir
      ? mkdirNode(seg, fullChildPath, hasKids)
      : mknondirNode(seg, fullChildPath, entry.size);

    children.push(node);
    seen.set(seg, node);
  }

  // When using the index, implicit directories (e.g. "out" when only
  // "out/file.js" exists) are not represented in the candidate list because
  // their entries live in deeper index buckets. Scan all index keys to
  // discover and create these missing directory nodes.
  if (index) {
    const prefix = parentPath ? parentPath + "/" : "";
    const implicitSegs = new Set<string>();
    for (const key of index.keys()) {
      if (!key.startsWith(prefix)) continue;
      const afterPrefix = key.slice(prefix.length);
      const slashIdx = afterPrefix.indexOf("/");
      const seg = slashIdx > 0 ? afterPrefix.slice(0, slashIdx) : afterPrefix;
      if (seg && !seen.has(seg)) {
        implicitSegs.add(seg);
      }
    }
    for (const seg of implicitSegs) {
      const fullChildPath = parentPath ? parentPath + "/" + seg : seg;
      const node: TreeNode = mkdirNode(seg, fullChildPath, true);
      children.push(node);
      seen.set(seg, node);
    }
    // Re-sort so implicit directories appear in the correct position
    children.sort((a, b) => {
      const aD = a.kind === "DIRECTORY" ? 0 : 1;
      const bD = b.kind === "DIRECTORY" ? 0 : 1;
      if (aD !== bD) return aD - bD;
      return a.name.localeCompare(b.name);
    });
  }

  return children;
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

/**
 * Build a map of directory path → {descendant file count, descendant dir count}
 * from the full flat entry list. Used by the frontend for accurate selection counts.
 */
export function buildDescendantCounts(
  entries: FlatEntry[],
): Map<string, { files: number; dirs: number; size: number }> {
  const index = new Map<string, FlatEntry[]>();
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, "/").split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!index.has(dir)) index.set(dir, []);
      index.get(dir)!.push(e);
    }
  }

  const result = new Map<string, { files: number; dirs: number; size: number }>();
  for (const [dir, children] of index) {
    let files = 0;
    let dirs = 0;
    let size = 0;
    for (const c of children) {
      if (c.type === "DIRECTORY") dirs++;
      else {
        files++;
        size += c.size;
      }
    }
    result.set(dir, { files, dirs, size });
  }
  return result;
}

export type { TreeNode, FlatEntry, EntryIndex };
export { buildTreeRootOnly, getDirChildren, buildEntryIndex, markNoisyDirs, countAllStats };
