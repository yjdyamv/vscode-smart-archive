import type { Ref } from "vue";
import type { WebviewToHost } from "../protocol";
import { isCoveredByAncestor } from "./useSelection";
import type { SelectionController } from "./useSelection";
import type { TreeController } from "./useTree";

export interface HostOpsContext {
  post: (msg: WebviewToHost) => void;
  tree: TreeController;
  selection: SelectionController;
  viewState: Ref<string>;
  loadingMsg: Ref<string>;
  pwError: Ref<boolean>;
  /** Current context-menu target directory ("" when the menu is closed). */
  getCtxDir: () => string;
}

/**
 * All webview → host operations. Internal seam of the archive view.
 * Feedback strings are not produced here — every user-facing message
 * comes from the host (localized in src/i18n.ts), so the webview never
 * keeps a parallel translation table.
 */
export function createHostOps(ctx: HostOpsContext) {
  const { post, tree, selection } = ctx;

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
  }

  function extSel() {
    const { paths, excludes } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "extSel", paths, excludes, flat: !isAnyDirSelected(paths) });
  }

  function copySel() {
    const { paths } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "copy", paths, flat: !isAnyDirSelected(paths) });
  }

  function delSel() {
    const { paths } = getEffectivePaths();
    if (!paths.length) return;
    post({ c: "delSel", paths });
    // Lock the tree while the host shows the confirm dialog; the host's
    // localized loading message replaces the overlay text after confirm.
    ctx.viewState.value = "loading";
  }

  function addFiles() {
    const dir = selection.state.lastAddDir;
    post({ c: "addFiles", dir });
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
  }

  function convertFormat() {
    post({ c: "convert" });
  }

  function mergeVolumes() {
    post({ c: "merge" });
  }

  function splitVolumes() {
    post({ c: "split" });
  }

  function encryptArchive() {
    post({ c: "encrypt" });
  }

  function decryptArchive() {
    post({ c: "decrypt" });
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
