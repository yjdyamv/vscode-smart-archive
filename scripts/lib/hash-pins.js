const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeFileAtomic } = require("./fs");

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Verify a downloaded/cached binary against its pinned hash. Fail-closed:
 * when `requireHash` is set and no pinned hash exists, refuse to use the
 * binary — UNLESS SA_HASH_BOOTSTRAP=1, which prints the computed hash so a
 * maintainer can populate the EXPECTED_HASHES map in one pass, then proceeds.
 * Bootstrap also covers an outdated pinned hash: with SA_HASH_BOOTSTRAP=1 a
 * mismatch prints the new hash and proceeds instead of failing, so one run
 * regenerates the whole map after a release bump.
 */
function checkHash(data, expected, requireHash, label) {
  const actual = sha256(data);
  if (expected) {
    if (actual !== expected) {
      if (process.env.SA_HASH_BOOTSTRAP === "1") {
        console.warn(`[hash-bootstrap] ${label} = ${actual} (pinned ${expected} is outdated)`);
        return;
      }
      throw new Error(`SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (requireHash) {
    if (process.env.SA_HASH_BOOTSTRAP === "1") {
      console.warn(`[hash-bootstrap] ${label} = ${actual}`);
      return;
    }
    throw new Error(
      `No pinned SHA-256 for "${label}". Refusing to bundle an unverified native binary.\n` +
        `  Collect hashes once:  SA_HASH_BOOTSTRAP=1 <build command>\n` +
        `  then paste the printed values into the EXPECTED_HASHES map.`,
    );
  }
}

/**
 * Rewrite one pinned SHA-256 inside an installer script's EXPECTED_HASHES
 * object literal (quoted or bare key). Used by SA_HASH_BOOTSTRAP so a single
 * run both stages the new binary and persists the regenerated hash.
 * Returns true when the file was updated.
 */
function updatePinnedHash(scriptPath, label, actualHash) {
  const text = fs.readFileSync(scriptPath, "utf8");
  const keys = [JSON.stringify(label)];
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) keys.push(label);
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escaped}\\s*:\\s*")[0-9a-f]{64}(")`);
    if (re.test(text)) {
      const next = text.replace(re, (_m, before, after) => before + actualHash + after);
      const mode = fs.statSync(scriptPath).mode;
      writeFileAtomic(scriptPath, Buffer.from(next));
      fs.chmodSync(scriptPath, mode);
      return true;
    }
  }
  return false;
}

/**
 * SA_HASH_BOOTSTRAP integration for installers: after a fresh download,
 * persist the regenerated hash into the installer's EXPECTED_HASHES map.
 * Prints a hint when the key is missing so a maintainer can add it manually.
 */
function persistBootstrapHash(scriptPath, destPath, label) {
  if (process.env.SA_HASH_BOOTSTRAP !== "1") return false;
  let actual;
  try {
    actual = sha256(fs.readFileSync(destPath));
  } catch {
    return false;
  }
  if (updatePinnedHash(scriptPath, label, actual)) {
    console.warn(
      `[hash-bootstrap] ${label}: pinned hash updated to ${actual} in ${path.basename(scriptPath)}`,
    );
    return true;
  }
  console.warn(
    `[hash-bootstrap] ${label} = ${actual} (no key in EXPECTED_HASHES — add it manually)`,
  );
  return false;
}

module.exports = {
  sha256,
  checkHash,
  updatePinnedHash,
  persistBootstrapHash,
};
