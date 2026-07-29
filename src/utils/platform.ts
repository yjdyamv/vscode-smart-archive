import { readFileSync } from "fs";
import { execSync } from "child_process";

export function isMusl(): boolean {
  try {
    if (readFileSync("/usr/bin/ldd", "utf8").includes("musl")) return true;
  } catch {}
  try {
    if (execSync("ldd --version", { encoding: "utf8", timeout: 3000 }).includes("musl"))
      return true;
  } catch {}
  return false;
}
