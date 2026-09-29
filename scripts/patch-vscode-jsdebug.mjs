#!/usr/bin/env node
/**
 * patch-vscode-jsdebug.mjs — restore F5 "Run Extension" debugging on the
 * VS Code 1.139 js-debug regression.
 *
 * Symptom: pressing F5 opens the Extension Development Host, then VS Code
 * reports "Extension host did not start in 10 seconds, it might be stopped
 * on the first line and needs a debugger to continue.", and the launching
 * window's exthost log fills with `connect ECONNREFUSED ::1:<port>`.
 *
 * Cause (upstream — not this repository): since VS Code 1.139 the bundled
 * js-debug looks the extension host up at `http://localhost:<port>` while
 * the host's inspector listens on 127.0.0.1 only. On machines where
 * `localhost` resolves to ::1 first, that probe is refused and the lookup
 * aborts, so the debugger never attaches and the host stays paused at
 * --inspect-brk.
 *   microsoft/vscode-js-debug#2416 · microsoft/vscode#338110
 *
 * Fix: point that one probe at 127.0.0.1. The request's Host header stays
 * "localhost", so the inspector's DNS-rebinding check still passes. This
 * edits the js-debug copy bundled with the VS Code install — not this
 * repository. A backup is kept beside the file as `extension.js.orig`.
 *
 * Usage:
 *   node scripts/patch-vscode-jsdebug.mjs            # patch (idempotent)
 *   node scripts/patch-vscode-jsdebug.mjs --revert   # restore the backup
 *   node scripts/patch-vscode-jsdebug.mjs --root="C:\Program Files\Microsoft VS Code"
 *
 * Close VS Code first: the file is loaded at startup, so a running
 * instance keeps the old code until it is fully restarted. A VS Code
 * update installs a fresh, unpatched js-debug — rerun the script if F5
 * breaks again. Once VS Code ships the upstream fix the pattern is gone
 * and the script reports "pattern not found" and changes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REL = ["resources", "app", "extensions", "ms-vscode.js-debug", "src", "extension.js"];
const UNPATCHED = /http:\/\/localhost:(\$\{[A-Za-z_$][\w$]*\.params\.port\})/;
const UNPATCHED_ALL = new RegExp(UNPATCHED.source, "g");
const PATCHED = /http:\/\/127\.0\.0\.1:(\$\{[A-Za-z_$][\w$]*\.params\.port\})/;

/**
 * Decide what to do with a js-debug bundle. Pure — never touches the disk,
 * so it stays testable.
 *
 * @param {string} source  contents of js-debug's src/extension.js
 * @returns {{ status: "patch" | "already" | "not-found" | "ambiguous", content: string, count: number }}
 */
export function rewrite(source) {
  if (PATCHED.test(source)) return { status: "already", content: source, count: 1 };
  const count = (source.match(UNPATCHED_ALL) ?? []).length;
  if (count === 0) return { status: "not-found", content: source, count };
  if (count > 1) return { status: "ambiguous", content: source, count };
  return {
    status: "patch",
    content: source.replace(UNPATCHED, "http://127.0.0.1:$1"),
    count,
  };
}

/** Candidate js-debug bundles under a VS Code root (stock + versioned layout). */
export function jsDebugFiles(root) {
  const files = [path.join(root, ...REL)];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  // Recent installs put resources under a commit-hash folder at the root.
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(path.join(root, entry.name, ...REL));
  }
  return files;
}

/** Default install locations, most common first. */
function defaultRoots() {
  const candidates = [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code"),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code Insiders"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code"),
  ];
  return candidates.filter((root) => root && fs.existsSync(root));
}

function resolveFile(rootOverride) {
  const roots = rootOverride ? [rootOverride] : defaultRoots();
  for (const root of roots) {
    for (const file of jsDebugFiles(root)) {
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

function patch(file) {
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`[patch-vscode-jsdebug] cannot read ${file}: ${err.message}`);
    return 1;
  }

  const result = rewrite(source);
  if (result.status === "already") {
    console.log("[patch-vscode-jsdebug] already patched — nothing to do");
    return 0;
  }
  if (result.status === "not-found") {
    console.log(
      "[patch-vscode-jsdebug] pattern not found — this js-debug build needs no workaround " +
        "(VS Code may have fixed the bug upstream); nothing changed",
    );
    return 0;
  }
  if (result.status === "ambiguous") {
    console.error(
      `[patch-vscode-jsdebug] expected 1 probe but found ${result.count} — refusing to patch`,
    );
    return 1;
  }

  const backup = `${file}.orig`;
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, result.content, "utf8");
  } catch (err) {
    console.error(`[patch-vscode-jsdebug] cannot write ${file}: ${err.message}`);
    console.error(
      "[patch-vscode-jsdebug] close every VS Code window and retry " +
        "(a system-wide install needs an elevated shell)",
    );
    return 1;
  }
  console.log(`[patch-vscode-jsdebug] patched ${file}`);
  console.log(`[patch-vscode-jsdebug] backup: ${backup}`);
  console.log("[patch-vscode-jsdebug] restart VS Code for the change to take effect");
  return 0;
}

function revert(file) {
  const backup = `${file}.orig`;
  if (!fs.existsSync(backup)) {
    console.error(`[patch-vscode-jsdebug] nothing to revert: ${backup} not found`);
    return 1;
  }
  try {
    fs.copyFileSync(backup, file);
    fs.rmSync(backup);
  } catch (err) {
    console.error(`[patch-vscode-jsdebug] cannot restore ${file}: ${err.message}`);
    return 1;
  }
  console.log(`[patch-vscode-jsdebug] restored ${file} from ${path.basename(backup)}`);
  return 0;
}

function usage() {
  console.log(
    "usage: node scripts/patch-vscode-jsdebug.mjs [--revert] [--root=<VS Code install folder>]",
  );
}

function main(argv) {
  let doRevert = false;
  let root;
  for (const arg of argv) {
    if (arg === "--revert") doRevert = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      return 0;
    } else if (arg.startsWith("--root="))
      root = arg.slice("--root=".length).replace(/^"+|"+$/g, "");
    else {
      console.error(`[patch-vscode-jsdebug] unknown argument: ${arg}`);
      usage();
      return 2;
    }
  }

  const file = resolveFile(root);
  if (!file) {
    console.error(
      "[patch-vscode-jsdebug] could not find the bundled js-debug — " +
        "pass --root=<VS Code install folder>",
    );
    return 1;
  }
  console.log(`[patch-vscode-jsdebug] js-debug: ${file}`);
  return doRevert ? revert(file) : patch(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
