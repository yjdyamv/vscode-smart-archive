/**
 * Browser dev sandbox for the webview UI — Smart Archiver webview
 *
 * `npm run dev:webview` serves the UI in a plain browser (vite dev server,
 * HMR) instead of a VS Code panel. There is no extension host there, so
 * this module provides a realistic fake archive and simulates the host's
 * expandDir answers: the tree, lazy expansion, search, selection and the
 * toolbar all behave like the real panel against mock data. Host messages
 * the sandbox cannot answer are logged to the console.
 */

import type { TreeNodeData } from "./types";
import type { InitialState, DescCount } from "./bootstrap";
import type { WebviewToHost } from "./protocol";

interface MockNode extends TreeNodeData {
  children?: MockNode[];
}

function dir(name: string, children: MockNode[], size = 0): MockNode {
  const path = children[0]?.path.slice(0, children[0].path.lastIndexOf("/")) || name;
  return { name, path, size, kind: "DIRECTORY", children };
}

function file(name: string, size: number, parentPath = ""): MockNode {
  return {
    name,
    path: parentPath ? `${parentPath}/${name}` : name,
    size,
    kind: "REGULAR_FILE",
  };
}

function buildMockTree(): MockNode[] {
  const src = dir("src", [
    file("main.ts", 2048, "src"),
    file("App.vue", 4096, "src"),
    dir("lib", [file("parser.ts", 1536, "src/lib"), file("utils.ts", 768, "src/lib")]),
    dir("components", [
      file("Toolbar.vue", 3072, "src/components"),
      file("FileTree.vue", 5120, "src/components"),
      dir("deep", [file("x.txt", 64, "src/components/deep")]),
    ]),
  ]);
  const docs = dir("docs", [file("index.md", 1024, "docs"), file("api.md", 2048, "docs")]);
  const assets = dir("assets", [
    file("logo.png", 65536, "assets"),
    file("bg.jpg", 131072, "assets"),
  ]);
  const nodeModules = dir("node_modules", [
    dir("vue", [file("index.js", 9999, "node_modules/vue")]),
  ]);
  return [src, docs, assets, nodeModules, file("README.md", 1234), file("package.json", 890)];
}

const fullTree = buildMockTree();

/** path → its direct children (root-only nodes keep [] until expanded). */
const childrenByPath = new Map<string, MockNode[]>();
function indexNodes(nodes: MockNode[]): void {
  for (const node of nodes) {
    childrenByPath.set(node.path, node.children ?? []);
    if (node.children) indexNodes(node.children);
  }
}
indexNodes(fullTree);

function allNodes(): MockNode[] {
  const out: MockNode[] = [];
  const walk = (nodes: MockNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(fullTree);
  return out;
}

function buildDescCounts(): Record<string, DescCount> {
  const out: Record<string, DescCount> = {};
  for (const node of allNodes()) {
    if (node.kind !== "DIRECTORY") continue;
    const files: string[] = [];
    const walk = (children: MockNode[]): void => {
      for (const c of children) {
        if (c.kind === "DIRECTORY") walk(c.children ?? []);
        else files.push(c.path);
      }
    };
    walk(node.children ?? []);
    const dirs = files.length > 0 ? countDirs(node) : 0;
    out[node.path] = {
      files: files.length,
      dirs,
      size: files.reduce((sum, p) => sum + (p === node.path ? 0 : nodeSize(p)), 0),
    };
  }
  return out;
}

function countDirs(node: MockNode): number {
  let dirs = 0;
  const walk = (children: MockNode[]): void => {
    for (const c of children) {
      if (c.kind === "DIRECTORY") {
        dirs++;
        walk(c.children ?? []);
      }
    }
  };
  walk(node.children ?? []);
  return dirs;
}

const nodeSizeByPath = new Map(allNodes().map((n) => [n.path, n.size] as const));
function nodeSize(path: string): number {
  return nodeSizeByPath.get(path) ?? 0;
}

export function mockInitialState(): InitialState {
  const all = allNodes();
  const files = all.filter((n) => n.kind === "REGULAR_FILE");
  const dirs = all.filter((n) => n.kind === "DIRECTORY");
  // Root-only initial tree: children stripped, hasMore set so the lazy
  // expandDir flow is exercised.
  const tree: TreeNodeData[] = fullTree.map((n) => ({
    name: n.name,
    path: n.path,
    size: n.size,
    kind: n.kind,
    children: n.kind === "DIRECTORY" ? [] : undefined,
    hasMore: n.kind === "DIRECTORY" && (n.children?.length ?? 0) > 0,
  }));
  return {
    tree,
    props: {
      name: "demo.7z",
      format: "7z",
      count: all.length,
      files: files.length,
      dirs: dirs.length,
      size: "1.2 MB",
      ratio: 0.42,
    },
    files: files.length,
    dirs: dirs.length,
    viewState: "content",
    toast: null,
    readOnly: false,
    isSplit: false,
    canSplit: true,
    isEncrypted: false,
    canEncrypt: true,
    descCounts: buildDescCounts(),
    expanded: [],
    ui: {},
  };
}

/** Children for an expandDir path (undefined = not part of the mock tree). */
export function mockDirChildren(path: string): TreeNodeData[] | undefined {
  const children = childrenByPath.get(path);
  if (!children) return undefined;
  return children.map((n) => ({
    name: n.name,
    path: n.path,
    size: n.size,
    kind: n.kind,
    children: n.kind === "DIRECTORY" ? [] : undefined,
    hasMore: n.kind === "DIRECTORY" && (n.children?.length ?? 0) > 0,
  }));
}

/** Simulate the extension host for the browser preview. */
export function installMockHost(): void {
  window.addEventListener("webview-to-host", ((e: Event) => {
    const msg = (e as CustomEvent<WebviewToHost>).detail;
    if (msg.c === "expandDir") {
      const children = mockDirChildren(msg.path);
      if (children) {
        window.postMessage({ c: "dirChildren", path: msg.path, children }, "*");
        return;
      }
    }
    if (msg.c !== "saveExpanded") {
      console.info("[mock host — unhandled]", msg);
    }
  }) as EventListener);
}
