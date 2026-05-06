/**
 * Wrapped archive helper — Smart Archive VSCode Extension
 *
 * Shared 3-instance pattern for wrapped format mutations (tar.gz, tar.xz, etc.):
 *   extract outer → mutate inner .tar → recompress.
 *
 * @module providers/archive/wrappedHelper
 */

import * as vscode from "vscode";
import * as path from "path";
import type { JS7zInstance } from "../../types";
import { JS7z, tryCleanupJS7z } from "../fileListing";
import { getFullExt, getWrapExtension } from "../../constants";
import { zstdCompress } from "../../engines/zstd-codec";
import { validatePassword } from "../../utils/security";
import { t } from "../../i18n";

/**
 * Run a mutation on a wrapped archive (tar.gz, tar.xz, etc.).
 *
 * 1. Extract outer compression layer
 * 2. Run `innerOp` on a fresh JS7z instance loaded with the inner .tar
 * 3. Recompress and write back
 */
export async function withWrappedArchive(
  archivePath: string,
  password: string | undefined,
  innerOp: (js7z2: JS7zInstance) => Promise<void>,
): Promise<void> {
  const ext = getFullExt(archivePath);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(archivePath));
  const archiveName = path.basename(archivePath);

  const js7z = await JS7z({ print: () => {}, printErr: () => {} });
  try {
    js7z.FS.writeFile(`/${archiveName}`, data);
    const tmpDir = "/_wrap1";
    js7z.FS.mkdir(tmpDir);

    const xArgs = ["x", `/${archiveName}`, `-o${tmpDir}`, "-y"];
    if (password) {
      validatePassword(password);
      xArgs.splice(1, 0, `-p${password}`);
    }
    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z x: ${c}`)));
      js7z.callMain(xArgs);
    });

    const top = js7z.FS.readdir(tmpDir).filter((e: string) => e !== "." && e !== "..");
    const innerTar = top.find((e: string) => e.endsWith(".tar"));
    if (!innerTar) throw new Error(t("archive.noInnerTar"));

    const innerData = js7z.FS.readFile(`${tmpDir}/${innerTar}`, { encoding: "binary" });
    const js7z2 = await JS7z({ print: () => {}, printErr: () => {} });
    try {
      js7z2.FS.writeFile("/inner.tar", new Uint8Array(innerData));

      await innerOp(js7z2);

      const modifiedTar = js7z2.FS.readFile("/inner.tar", { encoding: "binary" });
      const wrapExt = getWrapExtension(ext);

      let compressedData: Uint8Array;
      if (wrapExt === "zst") {
        compressedData = await zstdCompress(new Uint8Array(modifiedTar), 5);
      } else {
        const js7z3 = await JS7z({ print: () => {}, printErr: () => {} });
        try {
          js7z3.FS.writeFile("/_re.tar", new Uint8Array(modifiedTar));
          const compOut = `/_re.${wrapExt}`;
          const compArgs = ["a", compOut, "/_re.tar"];
          if (password) {
            validatePassword(password);
            compArgs.splice(1, 0, `-p${password}`);
          }
          await new Promise<void>((resolve, reject) => {
            js7z3.onExit = (c: number) => (c === 0 ? resolve() : reject(new Error(`7z a: ${c}`)));
            js7z3.callMain(compArgs);
          });
          compressedData = new Uint8Array(js7z3.FS.readFile(compOut, { encoding: "binary" }));
        } finally {
          tryCleanupJS7z(js7z3);
        }
      }

      await vscode.workspace.fs.writeFile(vscode.Uri.file(archivePath), compressedData);
    } finally {
      tryCleanupJS7z(js7z2);
    }
  } finally {
    tryCleanupJS7z(js7z);
  }
}
