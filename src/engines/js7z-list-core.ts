/**
 * js7z list & inspect core — Smart Archive VSCode Extension
 *
 * WASM listing/encryption-detection via the bundled 7zz engine, vscode-free (runs in
 * the worker thread). Host dispatcher: engines/js7z-list.ts.
 * Uses its own inline promise runner (not the shared run7z) because
 * print/printErr must be set at construction time for UTF-8 safety.
 *
 * @module engines/js7z-list-core
 */

import * as fs from "fs";
import { disposeJS7z } from "./js7z-helpers";
import { streamToVFS } from "./vfs-io";
import { getBaseName } from "../utils/path";
import { checkFileSize, validatePassword } from "../utils/security";
import { logger } from "../utils/logger-core";
import { isPasswordOrEncryptError } from "../utils/errorClassifier";
import { JS7z } from "./js7z-factory";
import { parse7zListing } from "../utils/parse7z";
import type { ListEntry } from "./fileListing-core";

export async function listFilesWasm(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<ListEntry[]> {
  logger.debug({ event: "listFiles.wasm.start", filePath, hasPassword: !!password });

  const useData = !!data;
  let stdout = "";
  let stderr = "";

  const js7z = await JS7z({
    print: (text: string) => {
      stdout += text + "\n";
    },
    printErr: (text: string) => {
      stderr += text + "\n";
    },
  });

  try {
    const archiveName = getBaseName(filePath);
    let archiveFsPath: string;
    if (useData) {
      js7z.FS.writeFile(`/${archiveName}`, data);
      archiveFsPath = `/${archiveName}`;
    } else {
      checkFileSize(fs.statSync(filePath).size);
      archiveFsPath = streamToVFS(js7z, filePath);
    }

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`7z l: ${code}\n${stderr}`));
      };
      const args = ["l", "-slt", "-sccUTF-8"];
      if (password) {
        validatePassword(password);
        args.splice(1, 0, `-p${password}`);
      }
      args.push(archiveFsPath);
      js7z.callMain(args);
    });

    const results = parse7zListing(stdout, archiveName);
    logger.debug({ event: "listFiles.wasm.done", count: results.length });
    return results;
  } finally {
    disposeJS7z(js7z);
  }
}

export async function isEncryptedWasm(filePath: string): Promise<boolean> {
  checkFileSize(fs.statSync(filePath).size);
  let stdout = "",
    stderr = "";
  const js7z = await JS7z({
    print: (text: string) => {
      stdout += text + "\n";
    },
    printErr: (text: string) => {
      stderr += text + "\n";
    },
  });

  try {
    const archiveFsPath = streamToVFS(js7z, filePath);

    try {
      await new Promise<void>((resolve, reject) => {
        js7z.onExit = (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`7z l: ${code}\n${stderr}`));
        };
        js7z.callMain(["l", "-slt", "-p", archiveFsPath]);
      });
      return stdout.includes("Encrypted = +");
    } catch {
      logger.warn(
        { event: "isEncrypted.detect.failed" },
        "Encryption detection via 7z test failed, checking stderr",
      );
      const msg = (stdout + stderr).toLowerCase();
      return isPasswordOrEncryptError(msg);
    }
  } finally {
    disposeJS7z(js7z);
  }
}
