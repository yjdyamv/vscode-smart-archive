/**
 * tar-writer symlink handling — Smart Archiver VSCode Extension
 *
 * Regression: a directory symlink/junction (e.g. .claude -> .agent) was
 * skipped entirely, so wrapped formats (tar.gz / tar.zst / ...) silently
 * dropped its contents while 7z/rar/zip stored them. The writer now follows
 * the link and stores the target's contents (WASM 7z cannot read GNU tar
 * type '2' symlink entries, so dereferencing is the only compatible way).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createTarFile } from "../src/engines/tar-writer";
import { tmpDir } from "./tmp";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function mkJunction(root: string, link: string, target: string): void {
  execSync(`cmd /c mklink /J "${link}" "${target}"`);
}

function readDirRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (fs.statSync(p).isDirectory()) {
        out.push(rel + "/");
        walk(p);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

describe("tar-writer symlink handling", () => {
  it.runIf(process.platform === "win32")(
    "follows a directory junction and stores its contents",
    async () => {
      const td = tmpDir("sat_tarsym_");
      dirs.push(td);
      const proj = path.join(td, "proj");
      const agent = path.join(proj, ".agent");
      fs.mkdirSync(agent, { recursive: true });
      fs.writeFileSync(path.join(agent, "config.json"), '{"a":1}');
      fs.mkdirSync(path.join(agent, "skills"));
      fs.writeFileSync(path.join(agent, "skills", "skill.md"), "# skill");
      mkJunction(proj, path.join(proj, ".claude"), agent);

      const tarPath = path.join(td, "proj.tar");
      await createTarFile(tarPath, [proj]);

      // Extract with system 7z (bundled 7zz) into a scratch dir.
      const out = path.join(td, "out");
      fs.mkdirSync(out, { recursive: true });
      const bin = path.join(
        __dirname,
        "..",
        "vendor",
        "7z-bin",
        process.platform,
        process.arch,
        "7zz.exe",
      );
      execSync(`"${bin}" x -y -o"${out}" "${tarPath}" >NUL 2>NUL`, { stdio: "pipe" });

      const extracted = readDirRecursive(out);
      expect(extracted).toContain("proj/.claude/");
      expect(extracted).toContain("proj/.claude/config.json");
      expect(extracted).toContain("proj/.claude/skills/");
      expect(extracted).toContain("proj/.claude/skills/skill.md");
      expect(fs.readFileSync(path.join(out, "proj", ".claude", "config.json"), "utf8")).toBe(
        '{"a":1}',
      );
      expect(
        fs.readFileSync(path.join(out, "proj", ".claude", "skills", "skill.md"), "utf8"),
      ).toBe("# skill");
    },
  );

  it.runIf(process.platform === "win32")(
    "skips circular directory junctions without infinite recursion",
    async () => {
      const td = tmpDir("sat_tarsym2_");
      dirs.push(td);
      const proj = path.join(td, "proj");
      const a = path.join(proj, "a");
      fs.mkdirSync(a, { recursive: true });
      fs.writeFileSync(path.join(a, "file.txt"), "hello");
      mkJunction(a, path.join(a, "loop"), proj);

      const tarPath = path.join(td, "proj.tar");
      await createTarFile(tarPath, [proj]);

      const out = path.join(td, "out");
      fs.mkdirSync(out, { recursive: true });
      const bin = path.join(
        __dirname,
        "..",
        "vendor",
        "7z-bin",
        process.platform,
        process.arch,
        "7zz.exe",
      );
      execSync(`"${bin}" x -y -o"${out}" "${tarPath}" >NUL 2>NUL`, { stdio: "pipe" });

      const extracted = readDirRecursive(out);
      expect(extracted).toContain("proj/a/file.txt");
      expect(fs.readFileSync(path.join(out, "proj", "a", "file.txt"), "utf8")).toBe("hello");
    },
  );
});