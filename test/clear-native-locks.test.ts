/**
 * clear-native-locks POSIX matcher tests — Smart Archive VSCode Extension
 *
 * The POSIX branch of scripts/clear-native-locks.mjs runs `ps` and reads
 * /proc/<pid>/cwd (or lsof on macOS), which cannot run on a Windows dev
 * machine. matchPosixLockers is a pure function over that data, so the
 * matching/cwd-verification logic is tested here with synthetic input.
 */

import { describe, expect, it } from "vitest";
import { matchPosixLockers } from "../scripts/clear-native-locks.mjs";

const REPO = "/home/user/vscode-smart-archive";

const PS_OUT = [
  "  1234 node /usr/lib/vscode/extensions/oxc.../server.js --stdio",
  "  2345 node /usr/lib/vscode/extensions/oxc.../oxlint.js --stdio",
  "  3456 /usr/bin/oxfmt --write .",
  "  4567 node /other/project/node_modules/.bin/oxlint --stdio",
  "  5678 node scripts/clear-native-locks.mjs",
  "  6789 node /usr/lib/vscode/extensions/oxc.../server.js --stdio",
].join("\n");

function cwdOf(pid) {
  const map = {
    1234: REPO, // oxc server inside this repo → kill
    2345: REPO, // oxlint server inside this repo → kill
    3456: REPO, // oxfmt CLI inside this repo → kill
    4567: "/other/project", // oxlint in another project → keep
    5678: REPO, // our own lock script → not matched by name anyway
    6789: null, // unverifiable cwd → keep (conservative)
  };
  return map[pid] ?? null;
}

describe("matchPosixLockers", () => {
  it("matches oxlint/oxfmt/oxc servers with cwd inside the repo", () => {
    const lockers = matchPosixLockers(PS_OUT, REPO, cwdOf);
    const ids = lockers.map((l) => l.pid).sort((a, b) => a - b);
    expect(ids).toEqual([1234, 2345, 3456]);
  });

  it("never matches processes without the oxc-family name", () => {
    const out = [
      "  5678 node scripts/clear-native-locks.mjs",
      "  7777 node scripts/npm-ci-safe.mjs",
    ].join("\n");
    expect(matchPosixLockers(out, REPO, cwdOf)).toEqual([]);
  });

  it("keeps servers whose cwd is in another project", () => {
    const out = "  4567 node /usr/lib/vscode/extensions/oxc/server.js --stdio";
    expect(matchPosixLockers(out, REPO, cwdOf)).toEqual([]);
  });

  it("keeps candidates whose cwd cannot be verified (no /proc, no lsof)", () => {
    const out = "  6789 node /usr/lib/vscode/extensions/oxc/server.js --stdio";
    expect(matchPosixLockers(out, REPO, cwdOf)).toEqual([]);
  });

  it("handles subdirectory cwds inside the repo", () => {
    const out = "  9999 oxfmt --check webview-ui/src";
    const lockers = matchPosixLockers(out, REPO, () => `${REPO}/webview-ui`);
    expect(lockers.map((l) => l.pid)).toEqual([9999]);
  });

  it("handles empty ps output", () => {
    expect(matchPosixLockers("", REPO, cwdOf)).toEqual([]);
  });
});
