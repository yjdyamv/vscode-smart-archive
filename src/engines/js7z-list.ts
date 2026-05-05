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
import { getBaseName, fixArchiveEncoding } from "../utils/path";
import { checkFileSize, validatePassword } from "../utils/security";
import { getSplitVolumeBase } from "../constants";
import { logger } from "../utils/logger";
import { JS7z } from "./js7z-factory";

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

    const results: { path: string; size: number; type: string }[] = [];
    let curPath = "";
    let curSize = 0;
    let curAttr = "";

    const flush = () => {
      if (curPath) {
        results.push({
          path: fixArchiveEncoding(curPath),
          size: curSize,
          type: curAttr.includes("D") ? "DIRECTORY" : "REGULAR_FILE",
        });
      }
      curPath = "";
      curSize = 0;
      curAttr = "";
    };

    for (const line of stdout.split("\n")) {
      const m = line.match(/^(\w[\w ]*?)\s*=\s*(.*)/);
      if (!m) continue;
      const key = m[1].trim();
      const val = m[2].trim();
      if (key === "Path") {
        flush();
        curPath = val;
      } else if (key === "Size" && !curSize) {
        curSize = parseInt(val, 10) || 0;
      } else if (key === "Attributes") {
        curAttr = val;
      }
    }
    flush();

    // 7z l -slt lists the archive file itself as the first entry; filter it out.
    // For split volumes, also filter the logical base name (e.g. "archive.7z"
    // embedded in the header of "archive.7z.001").
    const volBase = getSplitVolumeBase(archiveName);
    const filtered = results.filter((r) => {
      if (r.path === `/${archiveName}` || r.path === archiveName) return false;
      if (volBase && (r.path === `/${volBase}` || r.path === volBase)) return false;
      return true;
    });

    logger.debug({ event: "listFiles.done", count: filtered.length });
    return filtered;
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
