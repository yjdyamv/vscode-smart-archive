/**
 * js7z list & inspect — Smart Archive VSCode Extension
 *
 * Archive listing and encryption detection using js7z-tools.
 * Uses its own inline promise runner (not the shared run7z) because
 * print/printErr must be set at construction time for UTF-8 safety.
 *
 * @module engines/js7z-list
 */

import * as fs from "fs";
import { tryCleanup, run7z, streamToVFS } from "./js7z-helpers";
import { getBaseName } from "../utils/path";
import { checkFileSize, validatePassword } from "../utils/security";
import { logger } from "../utils/logger";
import { JS7z } from "./js7z-factory";
import { parse7zListing } from "../utils/parse7z";

export async function listFiles(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<{ path: string; size: number; type: string }[]> {
  logger.debug({ event: "listFiles.start", filePath, hasPassword: !!password });
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
    logger.debug({ event: "listFiles.done", count: results.length });
    return results;
  } finally {
    tryCleanup(js7z);
  }
}

export async function isEncrypted(filePath: string): Promise<boolean> {
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
      await run7z(js7z, ["l", "-slt", "-p", archiveFsPath]);
      return stdout.includes("Encrypted = +");
    } catch {
      logger.warn(
        { event: "isEncrypted.detect.failed" },
        "Encryption detection via 7z test failed, checking stderr",
      );
      const msg = (stdout + stderr).toLowerCase();
      return msg.includes("encrypted") || msg.includes("wrong password");
    }
  } finally {
    tryCleanup(js7z);
  }
}
