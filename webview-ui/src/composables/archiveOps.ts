import type { Ref } from "vue";
import type { WebviewToHost } from "../protocol";
import { isCoveredByAncestor } from "./useSelection";
import type { SelectionController } from "./useSelection";
import type { TreeController } from "./useTree";

export interface HostOpsContext {
  post: (msg: WebviewToHost) => void;
  tree: TreeController;
  selection: SelectionController;
  showToast: (msg: string, ok?: boolean) => void;
  viewState: Ref<string>;
  loadingMsg: Ref<string>;
  pwError: Ref<boolean>;
  /** Current context-menu target directory ("" when the menu is closed). */
  getCtxDir: () => string;
}

/** All webview → host operations. Internal seam of the archive view. */
export function createHostOps(ctx: HostOpsContext) {
  const { post, tree, selection, showToast } = ctx;

  function isAnyDirSelected(paths: string[]): boolean {
    for (const p of paths) {
      const node = tree.findNode(p);
      if (node && node.kind === "DIRECTORY") return true;
    }
    return false;
  }

  function getEffectivePaths(): { paths: string[]; excludes: string[] } {
    const raw = [...selection.state.selected];
    const paths = new Set<string>();
    const excludes = new Set<string>();
    for (const p of raw) {
      const node = tree.findNode(p);
      if (node && node.kind === "DIRECTORY" && node.children && node.children.length > 0) {
        const hasAnyChildSelected = node.children.some((c) => selection.state.selected.has(c.path));
        if (hasAnyChildSelected) {
          paths.add(p);
          for (const child of node.children) {
            if (!selection.state.selected.has(child.path)) excludes.add(child.path);
          }
        } else {
          paths.add(p);
        }
      } else {
        if (!isCoveredByAncestor(p, selection.state.selected)) paths.add(p);
      }
    }
    return { paths: [...paths], excludes: [...excludes] };
  }

  function extAll() {
    post({ c: "extAll" });
    showToast("Extracting all files...", true);
  }

  function extSel() {
    const { paths, excludes } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "extSel", paths, excludes, flat: !isAnyDirSelected(paths) });
    showToast("Extracting " + paths.length + " item(s)...", true);
  }

  function copySel() {
    const { paths } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "copy", paths, flat: !isAnyDirSelected(paths) });
    showToast("Copied " + paths.length + " item(s)", true);
  }

  function delSel() {
    const { paths } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "delSel", paths });
    ctx.loadingMsg.value = "Deleting " + paths.length + " item(s)...";
    ctx.viewState.value = "loading";
  }

  function addFiles() {
    const dir = selection.state.lastAddDir;
    post({ c: "addFiles", dir });
    showToast("Adding to " + (dir || "archive root"), true);
  }

  function previewFile(path: string) {
    post({ c: "preview", path });
  }

  function renameFile(path: string) {
    post({ c: "renamePrompt", path });
  }

  function newFolder() {
    const dir = selection.state.lastAddDir || ctx.getCtxDir() || "";
    post({ c: "newFolderPrompt", dir });
  }

  function testArchive() {
    post({ c: "test" });
    showToast("Testing archive integrity...", true);
  }

  function convertFormat() {
    post({ c: "convert" });
  }

  function mergeVolumes() {
    post({ c: "merge" });
    showToast("Merging split volumes...", true);
  }

  function splitVolumes() {
    post({ c: "split" });
  }

  function encryptArchive() {
    post({ c: "encrypt" });
    showToast("Adding encryption...", true);
  }

  function decryptArchive() {
    post({ c: "decrypt" });
    showToast("Removing encryption...", true);
  }

  function submitPassword(pw: string) {
    ctx.pwError.value = false;
    post({ c: "pw", pw });
  }

  return {
    getEffectivePaths,
    isAnyDirSelected,
    extAll,
    extSel,
    copySel,
    delSel,
    addFiles,
    previewFile,
    renameFile,
    newFolder,
    testArchive,
    convertFormat,
    mergeVolumes,
    splitVolumes,
    encryptArchive,
    decryptArchive,
    submitPassword,
  };
}
