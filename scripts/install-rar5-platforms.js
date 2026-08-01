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
const { httpGetMirrored, downloadWithCache } = require("./lib/download-cache");

const PKG_VERSION = "0.1.0"; // keep in sync with the binding package.json
const RELEASE_BASE = process.env.SA_RAR5_RELEASE_BASE ||
  `https://github.com/yjdyamv/smart-archive-rar/releases/download/v${PKG_VERSION}`;

// SHA-256 of each platform .node asset; fail-closed. Regenerate once a release
// exists: SA_HASH_BOOTSTRAP=1 node scripts/install-rar5-platforms.js
const EXPECTED_HASHES = {
  "linux-x64-gnu": "1d77e8428b2f9abbadc582a5a4ea944fd97dc4230be4058b370f55bdc288c291",
  "linux-x64-musl": "4421f41e27df2c21da29ac33ca27b2038e98409c4cf911b02c59e82915f33d48",
  "linux-arm64-gnu": "79a78d3c13c0ed7e7ccff7fc40641a6733bda32f7a604e9df19b98750a40ab6d",
  "linux-arm64-musl": "bad1f17f9cdb0a1ff06eac94b88db1ac44ff92320bc0a2b35912865b93bc3a38",
  "linux-arm-gnueabihf": "db68b28462cef2a5b777db059e75f7df75bde921dd0e35a640b134eebdd66bc7",
  "darwin-x64": "e02e80f1a4a98f31d24d81f35fba210f2ae99e72631e521f7e26e2a02d373339",
  "darwin-arm64": "ecf59bc42dfc7a4aa785c23cb7196bf0074ce4da99877668f3aa1082cf014ca4",
  "win32-x64-msvc": "1ba51bca7d2c6a6c4b2ea5376930a08c88c4f540691d62b6eb2aa6cd3421a632",
  "win32-ia32-msvc": "7d4a148c67161d9f8a345cf7c53a4f3d6bd9f7ec68aecb1b9792ea531b2371f6",
  "win32-arm64-msvc": "fce5411e3f85505e76abda860c77cc3f6d0b6f00d70436ca924a9324cd8e0edd",
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
  const project =
    process.env.SA_RAR5_PROJECT || path.join(os.homedir(), "桌面", "smart-archive-rar");
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

      const result = await downloadWithCache({
        cacheDir,
        cacheKey: nodeFileName,
        destPath,
        expectedSha256: hash,
        requireHash: !process.env.SA_HASH_BOOTSTRAP && strict,
        label: `rar5 ${triple}`,
        fetch: async () => {
          // Direct download first, mirror fallback (gh-proxy.com, or
          // SA_GITHUB_MIRRORS) on failure. SHA-256 pinning below keeps the
          // fail-closed guarantee regardless of the source.
          const url = `${RELEASE_BASE}/${nodeFileName}`;
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
  if (process.env.SA_RAR5_REQUIRE === "1") {
    // Fail-closed release build: every platform must be staged.
    await releaseMode(true);
    return;
  }
  // Local-first default: stage whatever local builds exist (dev ergonomics),
  // otherwise fall back to npm. Releases must use SA_RAR5_REQUIRE=1.
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

main();
