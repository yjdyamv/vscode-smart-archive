#!/usr/bin/env node
/**
 * Stage the rar5 native binding (smart-archive-rar, napi-rs) under rar5-bin/
 * for all desktop platforms, so the extension can create RAR5 archives
 * without any external binary.
 *
 * Modes:
 *
 *   1. Dev mode  — SA_RAR5_DEV=1 copies the locally built .node files from
 *      the binding project (default ~/桌面/smart-archive-rar). Use after:
 *        cd ~/桌面/smart-archive-rar && npm install && npx napi build --platform --release
 *
 *   2. Release mode (default) — downloads smart-archive-rar.<triple>.node from
 *      the binding's GitHub Release assets
 *      (https://github.com/yjdyamv/smart-archive-rar/releases), pinned against
 *      a SHA-256 hash (fail-closed). Set SA_RAR5_REQUIRE=1 for a fail-closed
 *      release build where every platform must stage.
 *
 * The loader (src/engines/rar5-engine.ts) resolves
 * rar5-bin/<platform>/<arch>/smart-archive-rar.<triple>.node
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { httpGet, httpGetMirrored, downloadWithCache } = require("./lib/download-cache");

// Binding repo, overridable (e.g. a fork):
//   SA_RAR5_REPO=me/smart-archive-rar
const REPO = process.env.SA_RAR5_REPO || "yjdyamv/smart-archive-rar";

// Fallback version used only when the GitHub API is unreachable. Prefer
// SA_RAR5_VERSION (explicit) — otherwise the latest release tag is resolved
// automatically (cached for 1 h under .cache/rar5-platforms/).
const PKG_VERSION_FALLBACK = "0.1.0";

const VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

async function resolveVersion() {
  if (process.env.SA_RAR5_VERSION) return process.env.SA_RAR5_VERSION;
  const cacheFile = path.join(cacheDir, "latest-version.txt");
  try {
    if (fs.existsSync(cacheFile)) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < VERSION_CACHE_TTL_MS) {
        const cached = fs.readFileSync(cacheFile, "utf8").trim();
        if (cached) return cached;
      }
    }
    const url = `https://api.github.com/repos/${REPO}/releases/latest`;
    const body = await httpGet(url, 5, 15000, {
      "User-Agent": "smart-archive-vscode",
      Accept: "application/vnd.github+json",
    });
    const tag = String(JSON.parse(body.toString("utf8")).tag_name).replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+/.test(tag)) throw new Error(`unexpected release tag: ${tag}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, tag);
    return tag;
  } catch (err) {
    console.warn(
      `  cannot resolve latest release of ${REPO} (${err.message}); ` +
        `falling back to ${PKG_VERSION_FALLBACK} — set SA_RAR5_VERSION to pin`,
    );
    return PKG_VERSION_FALLBACK;
  }
}

// SHA-256 of each platform .node release asset; fail-closed. Verify against
// the official GitHub digest (SA_VERIFY_RAR5_HASHES=1 npm test) after a new
// release, then regenerate here:
//   SA_HASH_BOOTSTRAP=1 node scripts/install-rar5-platforms.js
const EXPECTED_HASHES = {
  "linux-x64-gnu": "a36915083ef7ba5a75a2b18a3921b51be26a5a3afaff8f5d158843c7def45f1a",
  "linux-x64-musl": "4a71fcea1007831454c33d23f656e85ed3858c32c799a20ab15e50136432e486",
  "linux-arm64-gnu": "5c6962a6f51adb3d8839bc585fc5f9b36409e9e60fe696f601e600f47ab0a9b8",
  "linux-arm64-musl": "5d8f5b7bc654ac8b7db0df9fc80e53f3c40f1bbb0d8261018999e71bce0a2989",
  "linux-arm-gnueabihf": "f571c4885f837a31d0460993f0a76e5464e1fc21b07f3883d68bbff0c39b8f30",
  "darwin-x64": "e5c78bb2cff7ff11605a2a6d29769dfd224e4ae7552e2683080b530c699d5c00",
  "darwin-arm64": "762790e0b7c4bc34d438df60d4e6057821dce82583a8f2b0414e8e37d3e4ef77",
  "win32-x64-msvc": "313e39c1db62c0e596206877171294905ab8e023b2ab5af6a5de8fec8ba48380",
  "win32-ia32-msvc": "a69ca3c027becfce73bb7e04b59375b9dbd0a64d0def7a3aaad56c22c6518f56",
  "win32-arm64-msvc": "b864f93154a5ede710e0a793dd502408b43e974464355d8f45ca21f67c8ed025",
};

// <platform>/<arch> -> napi-rs triples
const TRIPLES = {
  "linux/x64": ["linux-x64-gnu", "linux-x64-musl"],
  "linux/arm64": ["linux-arm64-gnu", "linux-arm64-musl"],
  "linux/arm": ["linux-arm-gnueabihf"],
  "darwin/x64": ["darwin-x64"],
  "darwin/arm64": ["darwin-arm64"],
  "win32/x64": ["win32-x64-msvc"],
  "win32/ia32": ["win32-ia32-msvc"],
  "win32/arm64": ["win32-arm64-msvc"],
};

function devProject() {
  return process.env.SA_RAR5_PROJECT || path.join(os.homedir(), "桌面", "smart-archive-rar");
}

const destDir = path.join(__dirname, "..", "rar5-bin");
const cacheDir = path.join(__dirname, "..", ".cache", "rar5-platforms");
fs.mkdirSync(cacheDir, { recursive: true });

function stageNode(nodeData, triple) {
  const found = Object.entries(TRIPLES).find(([, triples]) => triples.includes(triple));
  if (!found) throw new Error(`unknown triple: ${triple}`);
  const [platform, arch] = found[0].split("/");
  const destPath = path.join(destDir, platform, arch, `smart-archive-rar.${triple}.node`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, nodeData);
  console.log(`  staged ${triple} -> rar5-bin/${platform}/${arch}/`);
}

function devMode() {
  const project = devProject();
  const candidates = [
    project, // napi build --platform copies the addon to the project root
    path.join(project, "target", "release"),
  ];
  let buildDir;
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.readdirSync(c).some((f) => f.endsWith(".node"))) {
      buildDir = c;
      break;
    }
  }
  if (!buildDir) {
    throw new Error(
      `no built .node found in ${project} — run 'npx napi build --platform --release' there`,
    );
  }
  const files = fs.readdirSync(buildDir).filter((f) => f.endsWith(".node"));
  for (const f of files) {
    const triple = f.replace(/^smart-archive-rar\./, "").replace(/\.node$/, "");
    stageNode(fs.readFileSync(path.join(buildDir, f)), triple);
  }
}

async function releaseMode(strict) {
  const platforms = process.env.SA_RAR5_PLATFORMS
    ? process.env.SA_RAR5_PLATFORMS.split(",").map((s) => s.trim())
    : Object.keys(TRIPLES);
  let installed = 0;
  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of platforms) {
    const [platform, arch] = key.split("/");
    const triples = TRIPLES[key] || [];
    for (const triple of triples) {
      console.log(`[rar5 ${triple}]`);
      const nodeFileName = `smart-archive-rar.${triple}.node`;
      const destPath = path.join(destDir, platform, arch, nodeFileName);
      const hash = EXPECTED_HASHES[triple];

      if (!hash && !process.env.SA_HASH_BOOTSTRAP) {
        if (strict) {
          throw new Error(
            `no pinned SHA-256 for ${triple} — add it to EXPECTED_HASHES after releasing, ` +
              `or use SA_RAR5_DEV=1 for local builds`,
          );
        }
        console.warn(
          `  no pinned SHA-256 for ${triple} — skipping (run SA_HASH_BOOTSTRAP=1 after releasing)`,
        );
        skipped++;
        continue;
      }

      const bootstrapping = process.env.SA_HASH_BOOTSTRAP === "1";
      const result = await downloadWithCache({
        cacheDir,
        cacheKey: nodeFileName,
        destPath,
        // Bootstrap: no pin yet — download and print the new hash so it can
        // be pasted into EXPECTED_HASHES. Otherwise the stale pin would
        // reject the freshly released binaries.
        expectedSha256: bootstrapping ? undefined : hash,
        requireHash: bootstrapping || strict,
        label: `rar5 ${triple}`,
        fetch: async () => {
          // Direct download first, mirror fallback (gh-proxy.com, or
          // SA_GITHUB_MIRRORS) on failure. SHA-256 pinning below keeps the
          // fail-closed guarantee regardless of the source.
          const url = `${releaseBase}/${nodeFileName}`;
          return httpGetMirrored(url);
        },
      });

      if (result.status === "skipped") {
        console.log("  skipped (already staged)");
        skipped++;
      } else if (result.status === "cached") {
        console.log("  from cache");
        cached++;
      } else if (result.status === "downloaded") {
        console.log("  downloaded + cached");
        installed++;
      } else {
        if (strict) {
          console.error("  FAILED");
          failed++;
        } else {
          console.warn("  not available (release not published yet)");
          skipped++;
        }
      }
    }
  }

  console.log(
    `rar5: ${installed} installed, ${cached} from cache, ${skipped} skipped, ${failed} failed`,
  );
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  if (process.env.SA_RAR5_DEV) {
    devMode();
    return;
  }

  // Version resolution: SA_RAR5_VERSION > cached latest-release > GitHub API
  // (with a documented fallback only when the API is unreachable).
  const version = await resolveVersion();
  releaseBase =
    process.env.SA_RAR5_RELEASE_BASE ||
    `https://github.com/${REPO}/releases/download/v${version}`;
  console.log(`rar5: resolving bindings from ${releaseBase}`);

  if (process.env.SA_RAR5_REQUIRE === "1") {
    // Fail-closed release build: every platform must be staged.
    await releaseMode(true);
    return;
  }
  // Local-first default: stage whatever local builds exist (dev ergonomics),
  // otherwise fall back to release downloads. Releases must use
  // SA_RAR5_REQUIRE=1.
  try {
    devMode();
    const staged = fs.readdirSync(destDir, { recursive: true }).filter((f) => f.endsWith(".node"));
    console.log(`rar5: staged ${staged.length} local .node(s)`);
    if (staged.length < 10) {
      console.warn(
        `WARNING: only ${staged.length}/10 platforms staged from local build. ` +
          "Set SA_RAR5_REQUIRE=1 for a fail-closed release build, or wait for the " +
          "GitHub Release (then run SA_HASH_BOOTSTRAP=1 once).",
      );
    }
  } catch {
    await releaseMode(false);
  }
}

let releaseBase = "";

if (require.main === module) {
  main();
}

module.exports = {
  REPO,
  PKG_VERSION_FALLBACK,
  resolveVersion,
  getReleaseBase: () => releaseBase,
  TRIPLES,
  EXPECTED_HASHES,
  devProject,
};
