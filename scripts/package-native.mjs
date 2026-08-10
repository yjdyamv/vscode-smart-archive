#!/usr/bin/env node
/**
 * Package the full (native) build of the extension — Smart Archive
 *
 * Produces smart-archive-<version>-native.vsix with every engine
 * included: native rar5/7zz/snappy binaries plus the WASI/WASM
 * fallbacks. This is the default `package:cross` artifact — named
 * with the `-native` suffix to distinguish it from the pure-WASM
 * package (scripts/package-wasm.mjs).
 *
 *   node scripts/package-native.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, `smart-archive-${pkg.version}-native.vsix`);

execFileSync("npx", ["vsce", "package", "-o", out], { cwd: root, stdio: "inherit" });
console.log(`native package: ${out}`);
