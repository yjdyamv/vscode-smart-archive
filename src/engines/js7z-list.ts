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
import type { JS7zFactory } from "../types";
import { tryCleanup, run7z } from "./js7z-helpers";
import { getBaseName, fixArchiveEncoding } from "../utils/path";
import { checkFileSize } from "../utils/security";
import { logger } from "../utils/logger";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JS7z: JS7zFactory = require("js7z-tools");

export async function listFiles(
  filePath: string,
  password = "",
  data?: Uint8Array,
): Promise<{ path: string; size: number; type: string }[]> {
  logger.debug({ event: "listFiles.start", filePath, hasPassword: !!password });
  const buf =
    data ??
    (() => {
      checkFileSize(fs.statSync(filePath).size);
      return fs.readFileSync(filePath);
    })();
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
    js7z.FS.writeFile(`/${archiveName}`, buf);

    await new Promise<void>((resolve, reject) => {
      js7z.onExit = (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`7z l: ${code}\n${stderr}`));
      };
      const args = ["l", "-slt", "-sccUTF-8"];
      if (password) args.splice(1, 0, `-p${password}`);
      args.push(`/${archiveName}`);
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
    const filtered = results.filter((r) => r.path !== `/${archiveName}` && r.path !== archiveName);

    logger.debug({ event: "listFiles.done", count: filtered.length });
    return filtered;
  } finally {
    tryCleanup(js7z);
  }
}

export async function isEncrypted(filePath: string): Promise<boolean> {
  checkFileSize(fs.statSync(filePath).size);
  const data = fs.readFileSync(filePath);
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
    const archiveName = getBaseName(filePath);
    js7z.FS.writeFile(`/${archiveName}`, data);

    try {
      await run7z(js7z, ["l", "-slt", "-p", `/${archiveName}`]);
      return stdout.includes("Encrypted = +");
    } catch {
      const msg = (stdout + stderr).toLowerCase();
      return msg.includes("encrypted") || msg.includes("wrong password");
    }
  } finally {
    tryCleanup(js7z);
  }
}
