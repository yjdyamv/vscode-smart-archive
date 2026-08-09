import fs from "fs";
import path from "path";
import { copyFileAtomic, writeFileAtomic } from "./fs.mjs";
import { sha256, checkHash } from "./hash-pins.mjs";

async function downloadWithCache({
  cacheDir,
  cacheKey,
  fetch,
  destPath,
  expectedSha256,
  requireHash,
  label,
}) {
  const name = label || cacheKey;
  const forceDownload = process.env.SA_FORCE_DOWNLOAD === "1";

  // A staged destination is only reusable when it already matches the
  // pinned hash. Anything else (local dev build, previous release, partial
  // write) must be replaced, otherwise a version bump silently ships stale
  // binaries. Bootstrap mode re-downloads fresh so the printed hash always
  // describes the current release asset. SA_FORCE_DOWNLOAD=1 skips the
  // cache/destination entirely for a fresh-download verification.
  if (!forceDownload && fs.existsSync(destPath)) {
    const existing = fs.readFileSync(destPath);
    if (expectedSha256 && sha256(existing) === expectedSha256) {
      return { status: "skipped" };
    }
    if (!expectedSha256 && !requireHash) {
      // No pin and not fail-closed: keep whatever a local/dev stage left.
      return { status: "skipped" };
    }
    fs.rmSync(destPath, { force: true });
  }

  const cachedFile = path.join(cacheDir, cacheKey);

  if (!forceDownload && fs.existsSync(cachedFile)) {
    const cached = fs.readFileSync(cachedFile);
    if (expectedSha256) {
      if (sha256(cached) !== expectedSha256) {
        // Stale cache from an older release (cache keys are versioned, but a
        // manually seeded cache may still collide): drop and download fresh.
        fs.rmSync(cachedFile, { force: true });
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        copyFileAtomic(cachedFile, destPath);
        return { status: "cached" };
      }
    } else if (requireHash) {
      // Bootstrap mode: ignore any cached bytes so the printed hash comes
      // from the current release asset.
      fs.rmSync(cachedFile, { force: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      copyFileAtomic(cachedFile, destPath);
      return { status: "cached" };
    }
  }

  let data;
  try {
    data = await fetch();
  } catch {
    try {
      fs.rmSync(destPath, { force: true });
      fs.rmSync(cachedFile, { force: true });
    } catch {}
    return { status: "failed" };
  }

  // Verify BEFORE writing. A hash failure must abort the whole build — it is
  // intentionally NOT caught by the network try/catch above (which only
  // tolerates transient download failures).
  checkHash(data, expectedSha256, requireHash, name);

  fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
  fs.writeFileSync(cachedFile, data);

  writeFileAtomic(destPath, data);
  return { status: "downloaded" };
}

/** Count downloadWithCache statuses for a run summary. */
function countStatuses(statuses) {
  return {
    installed: statuses.filter((s) => s === "downloaded").length,
    cached: statuses.filter((s) => s === "cached").length,
    skipped: statuses.filter((s) => s === "skipped").length,
    failed: statuses.filter((s) => s === "failed").length,
  };
}

export { downloadWithCache, countStatuses };
