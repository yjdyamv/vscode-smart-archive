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

/**
 * Extract the glibc version from `ldd --version` output.
 *
 * glibc prints the version twice in one of two shapes, depending on the
 * distro:
 *   "ldd (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35"
 *   "ldd (GNU libc) 2.31"
 * musl's ldd prints "musl libc (x86_64)" with the version on the next line,
 * which matches neither pattern → null.
 */
export function parseGlibcVersion(banner: string): string | null {
  const firstLine = banner.split("\n", 1)[0] ?? "";
  const m =
    /\bGLIBC\s+(\d+\.\d+(?:\.\d+)?)/i.exec(firstLine) ??
    /\bldd\s+\([^)]*\)\s+(\d+\.\d+(?:\.\d+)?)/i.exec(firstLine);
  return m ? m[1] : null;
}

/** Cached `ldd --version` probe — at most one spawn per process. */
let _lddOutput: string | null | undefined;

function lddOutput(): string | null {
  if (_lddOutput !== undefined) return _lddOutput;
  try {
    _lddOutput = execSync("ldd --version", { encoding: "utf8", timeout: 3000 });
  } catch {
    _lddOutput = null;
  }
  return _lddOutput;
}

/**
 * glibc version of the running host (e.g. "2.35"), or null when the host is
 * not glibc or the version cannot be determined.
 *
 * Exists because some dependency loaders (napi-rs natives) decide gnu vs musl
 * from a runtime probe that is unreliable inside an extension host; they need
 * a glibc version string, and a real one is preferable to a fabricated
 * placeholder. See `engines/snappy-codec.ts`.
 */
export function glibcVersion(): string | null {
  const out = lddOutput();
  return out === null ? null : parseGlibcVersion(out);
}
