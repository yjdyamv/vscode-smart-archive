#!/usr/bin/env node
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
 * Source: yjdyamv/7-Zip-zstd-native GitHub releases. Each downloaded
 * ARCHIVE is verified against a pinned SHA-256 (fail-closed). To
 * (re)generate hashes after a version bump, run once with
 * SA_HASH_BOOTSTRAP=1: the script prints and persists the new hashes into
 * EXPECTED_HASHES.
 *
 * NOTE: exact asset filenames / archive layout for a given release must be
 * confirmed on first run — a wrong name fails loudly (download or extract
 * error), never silently. Requires `tar` (with xz/gzip) on the build host.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const {
  downloadWithCache,
  writeFileAtomic,
  persistBootstrapHash,
} = require("./lib/download-cache");

// Keep in sync with the 7zz-wasm WASM engine version (README: 7-Zip 26.02).
// Native 7-Zip ZS (mcmilk/7-Zip-zstd fork) release published in our own repo.
const TAG = "v26.02-v1.5.7-R2";
const BASE = `https://github.com/yjdyamv/7-Zip-zstd-native/releases/download/${TAG}`;

// SHA-256 of each downloaded ARCHIVE, keyed by asset filename. Fail-closed:
// with no pinned hash the build refuses the binary unless SA_HASH_BOOTSTRAP=1.
//   SA_HASH_BOOTSTRAP=1 node scripts/install-7z-platforms.js
const EXPECTED_HASHES = {
  "7zz-linux-x64.tar.gz": "4b8185422d870425862c410854d352af30ab9c7e3b284589d14778236db32e96",
  "7zz-linux-arm64.tar.gz": "eb766d7a642241ded7c4544f43ea48b3c80a41aac344fd4fe10685b0be4eb476",
  "7zz-macos-arm64.tar.gz": "ff50ad7541a4124f276f9172e22b59dae6c777063b80883ead530f163c10c4a1",
  "7zz-windows-x64.zip": "02c72574b7b6cf53380f210b411bcacba5830c4d46deaf90c501fb79c0d62df4",
  "7zz-windows-arm64.zip": "67b0dac184c2ba13fec818140b513fd06edc195992d4598ed5b0dbe131256250",
};

const OUT = path.join(__dirname, "..", "vendor", "7z-bin");
const cacheDir = path.join(__dirname, "..", ".cache", "7z-platforms");

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

/** Recursively find a file by basename under a directory. */
function findFile(root, basename) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === basename) return full;
    }
  }
  return null;
}

/** Find a 7z/7zz binary usable on the current host to unpack Windows SFX. */
function hostSevenZip() {
  // Linux: use the just-staged linux-x64 7zz
  if (process.platform === "linux") {
    const p = path.join(OUT, "linux", "x64", "7zz");
    return fs.existsSync(p) ? p : null;
  }
  // macOS: look for system 7z (brew, etc.), then staged binary
  if (process.platform === "darwin") {
    for (const p of [
      "/opt/homebrew/bin/7zz",
      "/opt/homebrew/bin/7z",
      "/usr/local/bin/7zz",
      "/usr/local/bin/7z",
    ]) {
      if (fs.existsSync(p)) return p;
    }
    try {
      execFileSync("command", ["-v", "7zz"], { stdio: "pipe" });
      return "7zz";
    } catch {
      /* not on PATH */
    }
    try {
      execFileSync("command", ["-v", "7z"], { stdio: "pipe" });
      return "7z";
    } catch {
      /* not on PATH */
    }
    // Fall back to just-staged darwin binary
    for (const a of ["arm64", "x64"]) {
      const p = path.join(OUT, "darwin", a, "7zz");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  // Windows: check common install paths + PATH, then staged binary
  if (process.platform === "win32") {
    for (const p of [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "7-Zip", "7z.exe"),
      "C:\\Program Files\\7-Zip\\7z.exe",
      "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    ]) {
      if (fs.existsSync(p)) return p;
    }
    try {
      execFileSync("where", ["7z.exe"], { stdio: "pipe" });
      return "7z.exe";
    } catch {
      /* not on PATH */
    }
    try {
      execFileSync("where", ["7zz.exe"], { stdio: "pipe" });
      return "7zz.exe";
    } catch {
      /* not on PATH */
    }
    // Fall back to just-staged win32 binary (7zz.exe; 7z.exe covers stale
    // vendor dirs from older staging runs)
    for (const a of ["x64", "arm64", "ia32"]) {
      for (const bin of ["7zz.exe", "7z.exe"]) {
        const p = path.join(OUT, "win32", a, bin);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }
  return null;
}

function extract(kind, archivePath, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  if (kind === "tgz") {
    execFileSync("tar", ["-xzf", archivePath, "-C", tmpDir], { stdio: "inherit" });
  } else {
    const sz = hostSevenZip();
    if (!sz) {
      throw new Error(
        `Cannot extract Windows SFX on ${process.platform}-${process.arch}: no 7z/7zz found. ` +
          "On Linux/macOS install p7zip; on Windows install 7-Zip from https://www.7-zip.org/.",
      );
    }
    if (process.platform !== "win32") fs.chmodSync(sz, 0o755);
    execFileSync(sz, ["x", "-y", `-o${tmpDir}`, archivePath], { stdio: "inherit" });
  }
}

async function processTarget(t) {
  console.log(`[7z ${t.asset}]`);

  // Use downloadWithCache for the archive's on-disk path (a temp dir) — the
  // cache key is the asset name, so re-builds reuse the cached archive.tar.xz.
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
      fetch: async () => {
        const url = `${BASE}/${t.asset}`;
        const { httpGetMirrored } = require("./lib/download-cache");
        return httpGetMirrored(url);
      },
  });

  if (result.status === "failed") {
    throw new Error(
      `Failed to download ${t.asset} — refusing to build an incomplete cross-platform package`,
    );
  }
  if (result.status === "downloaded") {
    persistBootstrapHash(__filename, archivePath, t.asset);
  }

  fs.mkdirSync(unpackDir, { recursive: true });

  try {
    extract(t.kind, archivePath, unpackDir);
    for (const [srcName, outName] of Object.entries(t.pick)) {
      const src = findFile(unpackDir, srcName);
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
    const lic = findFile(unpackDir, "License.txt") || findFile(unpackDir, "LICENSE");
    if (lic && !fs.existsSync(path.join(OUT, "License.txt"))) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.copyFileSync(lic, path.join(OUT, "License.txt"));
    }
    // Keep the native build provenance (tag + upstream commit) in the bundle.
    if (t.native) {
      const ver = findFile(unpackDir, "VERSION");
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
  for (const t of TARGETS) {
    if (t === linuxX64) continue;
    await processTarget(t);
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

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
