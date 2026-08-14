#!/usr/bin/env node
/**
 * clear-native-locks.mjs — Windows safety net for `npm ci` / packaging.
 *
 * `npm ci` empties node_modules before reinstalling. Windows refuses to
 * unlink a native binding DLL (*.node) that some process still has loaded
 * into memory, so the install fails with EPERM (errno -4048) — e.g. a
 * lingering `oxfmt` or `oxlint` CLI, a Tailwind oxide server, or any dev
 * process that imported a native binding from this repo.
 *
 * This script finds every process that has a *.node module loaded from
 * this repo's node_modules (root and webview-ui) and terminates it, so the
 * following install/build can proceed. It is wired into package.json as
 * `prepackage:cross` (and `prepackage:wasm`), so it runs automatically
 * before packaging — no manual step needed.
 *
 * Kill → verify loop: some hosts (e.g. the VS Code oxc/oxlint extension)
 * automatically respawn their language server after it is killed, so a
 * single kill round is not enough. Detection is process-based (loaded
 * modules), because a rename probe does NOT work on Windows: a loaded DLL
 * may be renamed while it still cannot be unlinked, so file-level probes
 * falsely report "unlocked". After each kill round the script re-scans
 * loaded modules; if a respawned process holds a binding, another round
 * runs (up to MAX_ROUNDS). It only reports success once no process loads
 * any *.node file from this repo.
 *
 * Scope (safe by default):
 *   - `node` processes holding this repo's bindings are always terminated:
 *     they are stale formatter/linter/dev servers that would block the
 *     reinstall anyway.
 *   - VS Code (`Code`, incl. the extension dev host) is only included when
 *     SA_CLEAR_LOCKS_KILL_CODE=1, because killing it also closes the very
 *     window the terminal may run in. Prefer closing the dev host before
 *     packaging, or run from an external terminal with that env var set.
 *
 * Non-Windows platforms: no-op (exit 0).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "win32") {
  console.log("[clear-native-locks] not win32 - nothing to do");
  process.exit(0);
}

const ps = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$root = $env:SA_CLEAR_LOCKS_ROOT
if (-not $root) { Write-Error 'SA_CLEAR_LOCKS_ROOT is not set'; exit 1 }
$wsDirs = @((Join-Path $root 'node_modules'), (Join-Path $root 'webview-ui\node_modules'))
$killCode = $env:SA_CLEAR_LOCKS_KILL_CODE -eq '1'

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

$MAX_ROUNDS = 5
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
