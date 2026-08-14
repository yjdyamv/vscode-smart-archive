#!/usr/bin/env node
/**
 * clear-native-locks.mjs — cross-platform safety net for `npm ci` /
 * packaging, triggered by the oxc/oxlint/oxfmt VS Code extension.
 *
 * The oxc extension keeps a language server (a node process) alive that
 * loads this repo's native binding DLLs (*.node under node_modules and
 * webview-ui/node_modules). That breaks packaging:
 *
 *   - Windows: the unlink of a loaded DLL fails with EPERM (errno -4048),
 *     so `npm ci` dies while emptying node_modules.
 *   - Linux/macOS: unlink of a loaded file is allowed by POSIX semantics,
 *     so `npm ci` survives — but the server still holds the repo and can
 *     interfere (ETXTBSY when a binary is overwritten in place). We clear
 *     it there too so packaging runs in a pristine environment everywhere.
 *
 * Detection is process-based. On Windows a rename probe does NOT work: a
 * loaded DLL may be renamed while it still cannot be unlinked, so file
 * probes falsely report "unlocked" — loaded-module enumeration is the only
 * reliable signal. On POSIX, loaded-module enumeration is not available
 * without /proc tools, so processes are matched by command line
 * (oxlint/oxfmt/oxc) and verified to have their working directory inside
 * this repo (via /proc/<pid>/cwd, falling back to lsof) before killing —
 * unrelated servers in other projects are never touched.
 *
 * Kill → verify loop: the VS Code oxc extension respawns its server after
 * it is killed, so a single kill round is not enough. Each round re-scans;
 * up to MAX_ROUNDS, then a clear diagnostic is printed (the extension
 * should be closed or packaging run from a terminal without it).
 *
 * Wired into package.json as `prepackage:cross` (and `prepackage:wasm`),
 * so it runs automatically before packaging — no manual step needed.
 *
 * Non-Windows scope (safe by default): only `node` processes whose command
 * line names an oxc-family tool AND whose cwd is this repo are terminated.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ROUNDS = 5;

// ── POSIX (Linux / macOS) ─────────────────────────────────────────────

/**
 * Pure matcher over `ps -eo pid=,args=` output: pick oxc-family servers
 * whose working directory is inside this repo.
 *
 * Exported for tests (Windows dev machines can exercise the POSIX logic
 * with synthetic input); the production path calls it with real `ps`
 * output and a /proc (or lsof) cwd resolver.
 *
 * @param psOut      raw `ps -eo pid=,args=` text
 * @param repoRoot   absolute repo root (path prefix for cwd verification)
 * @param resolveCwd async/sync pid → cwd string | null (null = unverifiable)
 * @returns [{ pid, cmd }] processes to terminate
 */
export function matchPosixLockers(psOut, repoRoot, resolveCwd) {
  const nameRe = /(^|[^a-z])(oxlint|oxfmt|oxc)([^a-z]|$)/i;
  const candidates = [];
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, cmd] = m;
    if (!nameRe.test(cmd)) continue;
    candidates.push({ pid: Number(pidStr), cmd });
  }
  if (candidates.length === 0) return [];

  // Verify the process works inside this repo before killing anything —
  // other projects' oxc servers must be left alone. POSIX paths always use
  // "/" separators, so a plain string prefix check is correct here (and
  // keeps this matcher testable on Windows dev machines).
  const lockers = [];
  for (const c of candidates) {
    const cwd = resolveCwd(c.pid);
    if (!cwd) continue; // unverifiable — conservative, do not kill
    const repoPrefix = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
    if (cwd === repoRoot || cwd.startsWith(repoPrefix)) {
      lockers.push(c);
    }
  }
  return lockers;
}

/** Find oxc-family servers whose working directory is inside this repo. */
function findPosixLockers() {
  let psOut;
  try {
    psOut = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    console.warn(`[clear-native-locks] ps unavailable (${err.message}); skipping POSIX scan`);
    return [];
  }

  const resolveCwd = (pid) => {
    try {
      return execFileSync("readlink", ["-f", `/proc/${pid}/cwd`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // macOS has no /proc — fall back to lsof for the cwd descriptor.
      try {
        const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const cwdLine = out.split("\n").find((l) => l.startsWith("n"));
        if (cwdLine) return cwdLine.slice(1).trim();
      } catch {
        /* lsof missing or permission denied — cannot verify */
      }
      return null;
    }
  };

  return matchPosixLockers(psOut, root, resolveCwd);
}

async function posixMain() {
  let killed = 0;
  for (let round = 0; ; round++) {
    const lockers = findPosixLockers();
    if (lockers.length === 0) {
      if (round === 0) {
        console.log("[clear-native-locks] OK - no oxc/oxlint/oxfmt server holds this repo");
      } else {
        console.log(
          `[clear-native-locks] verified clean after ${round} round(s), ${killed} process(es) terminated`,
        );
      }
      process.exit(0);
    }
    if (round >= MAX_ROUNDS) {
      const ids = lockers.map((l) => `PID ${l.pid}`).join(", ");
      console.error(
        `[clear-native-locks] FAILED: oxc/oxlint/oxfmt server keeps respawning after ${MAX_ROUNDS} rounds (${ids}). Close the oxc VS Code extension or run packaging from a terminal without it, then retry.`,
      );
      process.exit(1);
    }
    for (const l of lockers) {
      console.log(`[clear-native-locks] terminating PID ${l.pid} (${l.cmd.slice(0, 100)})`);
      try {
        process.kill(l.pid, "SIGKILL");
        killed++;
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ── Windows ───────────────────────────────────────────────────────────

const ps = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$root = $env:SA_CLEAR_LOCKS_ROOT
if (-not $root) { Write-Error 'SA_CLEAR_LOCKS_ROOT is not set'; exit 1 }
$wsDirs = @((Join-Path $root 'node_modules'), (Join-Path $root 'webview-ui\node_modules'))
$killCode = $env:SA_CLEAR_LOCKS_KILL_CODE -eq '1'
$MAX_ROUNDS = 5

# Return a map of PID -> { Proc, Files } for every candidate process that
# has a *.node module loaded from this repo's node_modules dirs.
# Process-based detection: a loaded DLL can be RENAMED on Windows while it
# still cannot be UNLINKED, so file probes would falsely report "unlocked".
function Get-Lockers {
  $found = @{}
  foreach ($p in Get-Process) {
    $isNode = $p.ProcessName -eq 'node'
    $isCode = $killCode -and $p.ProcessName -eq 'Code'
    if (-not ($isNode -or $isCode)) { continue }
    $held = @()
    try {
      foreach ($m in $p.Modules) {
        if ($m.FileName -notlike '*.node') { continue }
        foreach ($d in $wsDirs) {
          $prefix = $d + '\'
          if ($m.FileName -like ($prefix + '*')) { $held += $m.FileName; break }
        }
      }
    } catch { }
    if ($held.Count -gt 0) { $found[$p.Id] = @{ Proc = $p; Files = $held } }
  }
  return $found
}

# Kill every process currently holding a binding. Returns the kill count.
# NOTE: diagnostics must use Write-Host — Write-Output strings would mix
# with the return value into one output stream and break the caller's
# $killed += Kill-Lockers (PowerShell object[] op_Addition failure).
function Kill-Lockers {
  $found = Get-Lockers
  if ($found.Count -eq 0) { return 0 }
  foreach ($id in ($found.Keys | Sort-Object)) {
    $e = $found[$id]
    Write-Host ("[clear-native-locks] terminating PID {0} ({1}) - holds:" -f $id, $e.Proc.ProcessName)
    $e.Files | ForEach-Object { Write-Host ("    {0}" -f $_) }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 400
  return $found.Count
}

$round = 0
$killed = 0
$first = Get-Lockers
if ($first.Count -eq 0) {
  Write-Output '[clear-native-locks] OK - no process holds a native .node binding from this repo'
  exit 0
}
while ($true) {
  $round++
  $killed += Kill-Lockers
  $remaining = Get-Lockers
  if ($remaining.Count -eq 0) {
    Write-Output ('[clear-native-locks] verified unlocked after {0} round(s), {1} process(es) terminated' -f $round, $killed)
    exit 0
  }
  if ($round -ge $MAX_ROUNDS) {
    $names = ($remaining.Keys | ForEach-Object { "PID $_" }) -join ', '
    Write-Error ("[clear-native-locks] FAILED: still locked after {0} rounds ({1}). " -f $MAX_ROUNDS, $names) + 'A host (e.g. the VS Code oxc/oxlint extension) keeps respawning its server. Close that extension/dev host or run packaging from a terminal without it, then retry.'
    exit 1
  }
  Write-Output ('[clear-native-locks] round {0}: {1} process(es) respawned, killing again' -f $round, $remaining.Count)
}
`;

// ── Entry ─────────────────────────────────────────────────────────────

async function main() {
  if (process.platform === "win32") {
    try {
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        {
          env: { ...process.env, SA_CLEAR_LOCKS_ROOT: root },
          stdio: "inherit",
        },
      );
    } catch (err) {
      process.exit(err.status ?? 1);
    }
    return;
  }
  await posixMain();
}

// Only run when invoked directly (node scripts/clear-native-locks.mjs) —
// tests import matchPosixLockers and must not trigger a live scan.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[clear-native-locks] FAILED: ${err?.message ?? err}`);
    process.exit(1);
  });
}
