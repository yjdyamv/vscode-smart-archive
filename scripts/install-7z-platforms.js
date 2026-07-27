#!/usr/bin/env node
/**
 * Stage full 7-Zip (7zz) console binaries for ALL platforms under 7z-bin/, so
 * the extension can bundle a native fast-path engine cross-platform (the WASM
 * js7z engine remains the universal fallback).
 *
 *   Linux / macOS : a single static `7zz` binary from the official .tar.xz.
 *                   (macOS ships a universal binary → used for x64 and arm64.)
 *   Windows       : the FULL-format `7z.exe` + `7z.dll` (the RAR codec lives in
 *                   7z.dll). The standalone `7za.exe` is reduced and lacks RAR,
 *                   so we extract 7z.exe/7z.dll from the official installer
 *                   (itself a 7-Zip SFX archive) using the Linux 7zz we stage.
 *
 * Source: official ip7z/7zip GitHub releases. Each downloaded ARCHIVE is
 * verified against a pinned SHA-256 (fail-closed). To (re)generate hashes after
 * a version bump, run once with SA_HASH_BOOTSTRAP=1 and paste the printed values
 * into EXPECTED_HASHES.
 *
 * NOTE: exact asset filenames / archive layout for a given release must be
 * confirmed on first run — a wrong name fails loudly (download or extract
 * error), never silently. Requires `tar` (with xz) on the build host.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { downloadWithCache } = require("./lib/download-cache");

// Keep in sync with the js7z WASM engine version (README: 7-Zip 26.02).
const VER = "26.02";
const TAG = "2602"; // filename token: 26.02 -> "2602"
const BASE = `https://github.com/ip7z/7zip/releases/download/${VER}`;

// SHA-256 of each downloaded ARCHIVE, keyed by asset filename. Fail-closed:
// with no pinned hash the build refuses the binary unless SA_HASH_BOOTSTRAP=1.
//   SA_HASH_BOOTSTRAP=1 node scripts/install-7z-platforms.js
const EXPECTED_HASHES = {
  "7z2602-linux-x64.tar.xz": "41aaba7b1235304ab5aa0624530c67ae829496cd29e875925271efdccc28c03e",
  "7z2602-linux-arm64.tar.xz": "70ea6cc737ae1495ea2d7eb20ef3120fe579bd3f1a83a9d2362b62ec5bde2bba",
  "7z2602-linux-arm.tar.xz": "81b7f04b3528852fac10f5becf9f15870a5da4cb94fbcb8a138197eb937468bf",
  "7z2602-mac.tar.xz": "1cf6760579502f87e591ff5c73a005ec50b3e4d6f507e8b038382d563c3175b9",
  "7z2602-x64.exe": "6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0",
  "7z2602-arm64.exe": "7c6fde79ed5e11b81c7bb6573b7962d3b6322aa5fce69c33ed19f672b55173ab",
  "7z2602.exe": "17d894c17b04984b6ffcc1b31926b39c42d315cd861c3adbf7f34bd941d529ac",
};

const OUT = path.join(__dirname, "..", "7z-bin");
const cacheDir = path.join(__dirname, "..", ".cache", "7z-platforms");

// asset : release file to download
// kind  : "txz" (tar.xz, extract via system tar) | "win" (SFX, extract via 7zz)
// dests : [ [nodePlatform, nodeArch], ... ] dirs under 7z-bin/ to populate
// pick  : { <path-inside-archive-basename>: <output-basename> }
const TARGETS = [
  {
    asset: `7z${TAG}-linux-x64.tar.xz`,
    kind: "txz",
    dests: [["linux", "x64"]],
    pick: { "7zzs": "7zz" },
  },
  {
    asset: `7z${TAG}-linux-arm64.tar.xz`,
    kind: "txz",
    dests: [["linux", "arm64"]],
    pick: { "7zzs": "7zz" },
  },
  {
    asset: `7z${TAG}-linux-arm.tar.xz`,
    kind: "txz",
    dests: [["linux", "arm"]],
    pick: { "7zzs": "7zz" },
  },
  // macOS: universal binary → one download serves both arches
  {
    asset: `7z${TAG}-mac.tar.xz`,
    kind: "txz",
    dests: [
      ["darwin", "x64"],
      ["darwin", "arm64"],
    ],
    pick: { "7zz": "7zz" },
  },
  // Windows: extract full-format console binary + codec dll from the installer
  {
    asset: `7z${TAG}-x64.exe`,
    kind: "win",
    dests: [["win32", "x64"]],
    pick: { "7z.exe": "7z.exe", "7z.dll": "7z.dll" },
  },
  {
    asset: `7z${TAG}-arm64.exe`,
    kind: "win",
    dests: [["win32", "arm64"]],
    pick: { "7z.exe": "7z.exe", "7z.dll": "7z.dll" },
  },
  {
    asset: `7z${TAG}.exe`,
    kind: "win",
    dests: [["win32", "ia32"]],
    pick: { "7z.exe": "7z.exe", "7z.dll": "7z.dll" },
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
    // Fall back to just-staged win32 binary
    for (const a of ["x64", "arm64", "ia32"]) {
      const p = path.join(OUT, "win32", a, "7z.exe");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  return null;
}

function extract(kind, archivePath, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  if (kind === "txz") {
    execFileSync("tar", ["-xJf", archivePath, "-C", tmpDir], { stdio: "inherit" });
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
      const { httpGet } = require("./lib/download-cache");
      return httpGet(url);
    },
  });

  if (result.status === "failed") {
    throw new Error(
      `Failed to download ${t.asset} — refusing to build an incomplete cross-platform package`,
    );
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
        fs.writeFileSync(dest, bytes);
        if (plat !== "win32") fs.chmodSync(dest, 0o755);
      }
      console.log(`  ${srcName} -> ${t.dests.map(([p, a]) => `${p}/${a}/${outName}`).join(", ")}`);
    }
    // Ship the 7-Zip license once (LGPL compliance).
    const lic = findFile(unpackDir, "License.txt");
    if (lic && !fs.existsSync(path.join(OUT, "License.txt"))) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.copyFileSync(lic, path.join(OUT, "License.txt"));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`Staging 7-Zip ${VER} binaries into ${path.relative(process.cwd(), OUT)}/`);
  // Linux x64 must be processed first — its 7zz is the host tool used to
  // unpack the Windows SFX installers on Linux build hosts.
  const linuxX64 = TARGETS.find(
    (t) => t.kind === "txz" && t.dests.some(([p, a]) => p === "linux" && a === "x64"),
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
      const bin = plat === "win32" ? "7z.exe" : "7zz";
      const f = path.join(OUT, plat, arch, bin);
      if (fs.existsSync(f)) staged.push(`${plat}/${arch}`);
    }
  }
  console.log(`\n=== 7-Zip ${VER}: staged ${new Set(staged).size} platform dirs ===`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
