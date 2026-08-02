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
  if (process.env.SA_RAR5_VERSION) return process.env.SA_RAR5_VERSION.replace(/^v/, "");
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
  "linux-x64-gnu": "b6ed2f918ceeb549df8c899fe9108bad52df5c3d6af60a47c55210a7070ba3cb",
  "linux-x64-musl": "723dbf747ce33bf6ab69f85ff0272b91aade86bbbd233e515b3d0cb5e3bbc01e",
  "linux-arm64-gnu": "6c59353c1c026c8938daf1d38262139794c6d7d1b52207d6159100824f3ad64e",
  "linux-arm64-musl": "83fbe7ac63fbefa334b8e82ab2667cc403919a1844bd6db8c5cea0fd4aa792b0",
  "linux-arm-gnueabihf": "1a3be45e3d4dd8f63de88364bce8f64fdfa068562dcd9ac3b46a8a35d4c82b37",
  "darwin-x64": "d60ed0cb63328710858524ee315a107bac1b31ece2fa29b647a3df405036193d",
  "darwin-arm64": "c144de3ee8241afbc7798aa40689af25a0ff9c139da88dc64d9d3df07e5abbf1",
  "win32-x64-msvc": "f832bc0a62e809d08786b7b84a31a025e1dcb6623fb8997ba901f015201a68ec",
  "win32-ia32-msvc": "58141c9cf7e19e8670270bc3b8f7db29216d94953c6611edca928e46ede2f445",
  "win32-arm64-msvc": "adad3ccb05669ea178e366bdc89aa731a90faf5f96168faa98af645a3b4e3546",
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
    process.env.SA_RAR5_RELEASE_BASE || `https://github.com/${REPO}/releases/download/v${version}`;
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
