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
const PKG_VERSION_FALLBACK = "0.2.9";

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
  "linux-x64-gnu": "fc43518e00e1c227ec9aa1bf23c03b4a5d4fd58b5d94d760dfcf1bd70938aedc",
  "linux-x64-musl": "691a1e70ae897bf9a5ac6374e681513a55629fb1e2e9138b7ad7c04252d6347d",
  "linux-arm64-gnu": "b58de778e9ec17d319cb20c059b99807b1c48c46a1f33e13b5deb6fb4e857f5c",
  "linux-arm64-musl": "0cc6cff05c8b1bf554dfabc37bfd6d1681211a21d06a951287f5543ceae58004",
  "linux-arm-gnueabihf": "f6642d89992c6723a3647a710c00f4423a70186a3efc3e407e3018bfcc12d5f0",
  "darwin-x64": "f3b461d25b30a5702e01e4e90c515056f65e2161e4333d24d4f7ba82654e6589",
  "darwin-arm64": "c4c39428f56dcb3f91b84ee459b13de1e9f8092ce7c330fad7bd644d8d5e8ecf",
  "win32-x64-msvc": "628c67545a511130e17a828db149962db6ab95121fec93ac74ef551dc704fd91",
  "win32-ia32-msvc": "c5b7f3c5eee7ff4649cc40e524ea450fe4c1ea4de49eaa65f891b4540c56f7c1",
  "win32-arm64-msvc": "9c6460f90b026b90c589ae34bbbc06051f0d7e15bcbb4003c9097a829a48384b",
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
  const jobs = [];
  for (const key of platforms) {
    const [platform, arch] = key.split("/");
    const triples = TRIPLES[key] || [];
    for (const triple of triples) {
      jobs.push({
        key,
        platform,
        arch,
        triple,
        nodeFileName: `smart-archive-rar.${triple}.node`,
        destPath: path.join(destDir, platform, arch, `smart-archive-rar.${triple}.node`),
        hash: EXPECTED_HASHES[triple],
      });
    }
  }

  // Download concurrently (bounded) — 10 platform assets staged in ~one
  // round-trip instead of ten sequential downloads.
  const CONCURRENCY = 5;
  const statuses = await mapLimit(jobs, CONCURRENCY, async (job) => {
    console.log(`[rar5 ${job.triple}]`);
    if (!job.hash && !process.env.SA_HASH_BOOTSTRAP) {
      if (strict) {
        throw new Error(
          `no pinned SHA-256 for ${job.triple} — add it to EXPECTED_HASHES after releasing, ` +
            `or use SA_RAR5_DEV=1 for local builds`,
        );
      }
      console.warn(
        `  no pinned SHA-256 for ${job.triple} — skipping (run SA_HASH_BOOTSTRAP=1 after releasing)`,
      );
      return "skipped";
    }

    const bootstrapping = process.env.SA_HASH_BOOTSTRAP === "1";
    const result = await downloadWithCache({
      cacheDir,
      cacheKey: job.nodeFileName,
      destPath: job.destPath,
      // Bootstrap: no pin yet — download and print the new hash so it can
      // be pasted into EXPECTED_HASHES. Otherwise the stale pin would
      // reject the freshly released binaries.
      expectedSha256: bootstrapping ? undefined : job.hash,
      requireHash: bootstrapping || strict,
      label: `rar5 ${job.triple}`,
      fetch: async () => {
        // Direct download first, mirror fallback (gh-proxy.com, or
        // SA_GITHUB_MIRRORS) on failure. SHA-256 pinning below keeps the
        // fail-closed guarantee regardless of the source.
        const url = `${releaseBase}/${job.nodeFileName}`;
        return httpGetMirrored(url);
      },
    });

    if (result.status === "skipped") {
      console.log("  skipped (already staged)");
      return "skipped";
    }
    if (result.status === "cached") {
      console.log("  from cache");
      return "cached";
    }
    if (result.status === "downloaded") {
      console.log("  downloaded + cached");
      return "downloaded";
    }
    if (strict) {
      console.error("  FAILED");
      return "failed";
    }
    console.warn("  not available (release not published yet)");
    return "skipped";
  });

  const installed = statuses.filter((s) => s === "downloaded").length;
  const cached = statuses.filter((s) => s === "cached").length;
  const skipped = statuses.filter((s) => s === "skipped").length;
  const failed = statuses.filter((s) => s === "failed").length;
  console.log(
    `rar5: ${installed} installed, ${cached} from cache, ${skipped} skipped, ${failed} failed`,
  );
  if (failed > 0) process.exitCode = 1;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
