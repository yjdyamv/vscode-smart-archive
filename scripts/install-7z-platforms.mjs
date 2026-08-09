#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import fs from "fs";
import path from "path";
import os from "os";
import { fetchReleaseAsset } from "./lib/github.mjs";
import { SEVEN_ZIP_ZSTD_REPO, SEVEN_ZIP_ZSTD_TAG } from "./lib/releases.mjs";
import { downloadWithCache } from "./lib/download.mjs";
import { persistBootstrapHash } from "./lib/hash-pins.mjs";
import { writeFileAtomic } from "./lib/fs.mjs";
import { findFileInTree, extractArchive } from "./lib/archive.mjs";
/**
 * Stage native 7-Zip ZS (7zz) console binaries for the platforms that have
 * builds under vendor/7z-bin/, so the extension can bundle a native fast-path
 * engine (the WASM 7zz engine remains the universal fallback).
 *
 *   linux x64/arm64, macOS arm64, Windows x64/arm64: native 7-Zip ZS
 *   binaries from yjdyamv/7-Zip-zstd-native (mcmilk fork). Single static
 *   binaries (`7zz` on Linux/macOS, `7zz.exe` on Windows — one consistent
 *   name across platforms, all codecs included).
 *
 * Platforms without a native build (linux arm, macOS x64, Windows ia32) get
 * no bundled binary — system7z.ts returns null there and the WASM engine
 * takes over.
 *
 * Source: yjdyamv/7-Zip-zstd-native GitHub releases (shared release constants
 * live in scripts/lib/releases.js). Each downloaded ARCHIVE is verified
 * against a pinned SHA-256 (fail-closed). To (re)generate hashes after a
 * version bump, run once with SA_HASH_BOOTSTRAP=1: the script prints and
 * persists the new hashes into EXPECTED_HASHES.
 *
 * NOTE: exact asset filenames / archive layout for a given release must be
 * confirmed on first run — a wrong name fails loudly (download or extract
 * error), never silently. Requires `tar` (with xz/gzip) on the build host.
 */

// Native 7-Zip ZS (mcmilk/7-Zip-zstd fork) release published in our own repo.
const REPO = SEVEN_ZIP_ZSTD_REPO;
const TAG = SEVEN_ZIP_ZSTD_TAG;

// SHA-256 of each downloaded ARCHIVE, keyed by asset filename. Fail-closed:
// with no pinned hash the build refuses the binary unless SA_HASH_BOOTSTRAP=1.
//   SA_HASH_BOOTSTRAP=1 node scripts/install-7z-platforms.mjs
const EXPECTED_HASHES = {
  "7zz-linux-x64.tar.gz": "4b8185422d870425862c410854d352af30ab9c7e3b284589d14778236db32e96",
  "7zz-linux-arm64.tar.gz": "eb766d7a642241ded7c4544f43ea48b3c80a41aac344fd4fe10685b0be4eb476",
  "7zz-macos-arm64.tar.gz": "ff50ad7541a4124f276f9172e22b59dae6c777063b80883ead530f163c10c4a1",
  "7zz-windows-x64.zip": "02c72574b7b6cf53380f210b411bcacba5830c4d46deaf90c501fb79c0d62df4",
  "7zz-windows-arm64.zip": "67b0dac184c2ba13fec818140b513fd06edc195992d4598ed5b0dbe131256250",
};

const OUT = path.join(import.meta.dirname, "..", "vendor", "7z-bin");
const cacheDir = path.join(import.meta.dirname, "..", ".cache", "7z-platforms");

// asset : release file to download
// kind  : "tgz" (tar.gz, extract via system tar) | "zip" (extract via 7zz)
// dests : [ [nodePlatform, nodeArch], ... ] dirs under vendor/7z-bin/ to populate
// pick  : { <path-inside-archive-basename>: <output-basename> }
const TARGETS = [
  {
    asset: "7zz-linux-x64.tar.gz",
    kind: "tgz",
    dests: [["linux", "x64"]],
    pick: { "7zz": "7zz" },
    native: true,
  },
  {
    asset: "7zz-linux-arm64.tar.gz",
    kind: "tgz",
    dests: [["linux", "arm64"]],
    pick: { "7zz": "7zz" },
    native: true,
  },
  {
    asset: "7zz-macos-arm64.tar.gz",
    kind: "tgz",
    dests: [["darwin", "arm64"]],
    pick: { "7zz": "7zz" },
    native: true,
  },
  {
    asset: "7zz-windows-x64.zip",
    kind: "zip",
    dests: [["win32", "x64"]],
    // Keep the native 7zz.exe name — mac/linux/win all use `7zz`.
    pick: { "7zz.exe": "7zz.exe" },
    native: true,
  },
  {
    asset: "7zz-windows-arm64.zip",
    kind: "zip",
    dests: [["win32", "arm64"]],
    pick: { "7zz.exe": "7zz.exe" },
    native: true,
  },
];

async function processTarget(t) {
  console.log(`[7z ${t.asset}]`);

  // Use downloadWithCache for the archive's on-disk path (a temp dir) — the
  // cache key is the asset name, so re-builds reuse the cached archive.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa7zdl_"));
  const archivePath = path.join(tmpDir, t.asset);
  const unpackDir = path.join(tmpDir, "unpacked");

  const result = await downloadWithCache({
    cacheDir,
    cacheKey: t.asset,
    destPath: archivePath,
    expectedSha256: EXPECTED_HASHES[t.asset],
    requireHash: true,
    label: t.asset,
    fetch: () =>
      fetchReleaseAsset({
        repo: REPO,
        tag: TAG,
        assetName: t.asset,
        expectedSha256: EXPECTED_HASHES[t.asset],
      }),
  });

  if (result.status === "failed") {
    throw new Error(
      `Failed to download ${t.asset} — refusing to build an incomplete cross-platform package`,
    );
  }
  if (result.status === "downloaded") {
    persistBootstrapHash(import.meta.filename, archivePath, t.asset);
  }

  fs.mkdirSync(unpackDir, { recursive: true });

  try {
    extractArchive(t.kind, archivePath, unpackDir, { stagedRoot: OUT });
    for (const [srcName, outName] of Object.entries(t.pick)) {
      const src = findFileInTree(unpackDir, srcName);
      if (!src) throw new Error(`"${srcName}" not found inside ${t.asset}`);
      const bytes = fs.readFileSync(src);
      for (const [plat, arch] of t.dests) {
        const destDir = path.join(OUT, plat, arch);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, outName);
        // Atomic replace: a previous 7zz may still be running (ETXTBSY if
        // written in place). Rename lets the old inode finish while the new
        // binary takes over the path.
        writeFileAtomic(dest, bytes);
        if (plat !== "win32") fs.chmodSync(dest, 0o755);
      }
      console.log(`  ${srcName} -> ${t.dests.map(([p, a]) => `${p}/${a}/${outName}`).join(", ")}`);
    }
    // Ship the 7-Zip license once (LGPL compliance); native archives carry
    // it as LICENSE, official ones as License.txt.
    const lic = findFileInTree(unpackDir, "License.txt") || findFileInTree(unpackDir, "LICENSE");
    if (lic && !fs.existsSync(path.join(OUT, "License.txt"))) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.copyFileSync(lic, path.join(OUT, "License.txt"));
    }
    // Keep the native build provenance (tag + upstream commit) in the bundle.
    if (t.native) {
      const ver = findFileInTree(unpackDir, "VERSION");
      if (ver) {
        fs.mkdirSync(OUT, { recursive: true });
        writeFileAtomic(path.join(OUT, "VERSION-native"), fs.readFileSync(ver));
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`Staging 7-Zip ZS ${TAG} binaries into ${path.relative(process.cwd(), OUT)}/`);
  // Start from a clean slate: previous staging runs may have left platform
  // dirs that no longer exist (old official 7-Zip layout, dropped platforms,
  // stray DLLs) — they must never end up in the VSIX.
  if (fs.existsSync(OUT)) {
    for (const entry of fs.readdirSync(OUT, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(OUT, entry.name), { recursive: true, force: true });
        console.log(`  cleared ${entry.name}/`);
      }
    }
  }
  // Linux x64 must be processed first — its 7zz is the host tool used to
  // unpack the Windows zip archives on Linux build hosts.
  const linuxX64 = TARGETS.find(
    (t) => t.kind === "tgz" && t.dests.some(([p, a]) => p === "linux" && a === "x64"),
  );
  if (linuxX64) {
    await processTarget(linuxX64);
  }
  const rest = TARGETS.filter((t) => t !== linuxX64);
  // On macOS hosts the staged darwin 7zz is the tool used to unpack the
  // Windows zips, so stage it before parallelizing the remaining targets.
  const darwin =
    process.platform === "darwin"
      ? rest.find((t) => t.dests.some(([p]) => p === "darwin"))
      : undefined;
  if (darwin) {
    await processTarget(darwin);
  }
  // The remaining targets are independent — download/extract in parallel.
  await Promise.all(rest.filter((t) => t !== darwin).map((t) => processTarget(t)));
  // Prune cache entries for assets that are no longer staged (e.g. the old
  // official 7-Zip archives) so version/platform changes leave no junk.
  if (fs.existsSync(cacheDir)) {
    const expected = new Set(TARGETS.map((t) => t.asset));
    for (const f of fs.readdirSync(cacheDir)) {
      if (!expected.has(f)) {
        fs.rmSync(path.join(cacheDir, f), { force: true });
        console.log(`  pruned stale cache ${f}`);
      }
    }
  }
  // LGPL compliance is mandatory — fail closed if the license text was not staged.
  if (!fs.existsSync(path.join(OUT, "License.txt"))) {
    throw new Error(
      "7-Zip License.txt was not staged (LGPL requirement) — upstream archive layout may have changed",
    );
  }
  // Report
  const staged = [];
  for (const t of TARGETS) {
    for (const [plat, arch] of t.dests) {
      const bin = plat === "win32" ? "7zz.exe" : "7zz";
      const f = path.join(OUT, plat, arch, bin);
      if (fs.existsSync(f)) staged.push(`${plat}/${arch}`);
    }
  }
  console.log(`\n=== 7-Zip ZS ${TAG}: staged ${new Set(staged).size} platform dirs ===`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export { REPO, TAG, TARGETS, EXPECTED_HASHES };
