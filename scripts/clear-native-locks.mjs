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
if ($found.Count -eq 0) {
  Write-Output '[clear-native-locks] OK - no process holds a native .node binding from this repo'
} else {
  foreach ($id in ($found.Keys | Sort-Object)) {
    $e = $found[$id]
    Write-Output ("[clear-native-locks] terminating PID {0} ({1}) - holds:" -f $id, $e.Proc.ProcessName)
    $e.Files | ForEach-Object { Write-Output ("    {0}" -f $_) }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  Write-Output '[clear-native-locks] done - reinstall can proceed'
}
exit 0
`;

execFileSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
  {
    env: { ...process.env, SA_CLEAR_LOCKS_ROOT: root },
    stdio: "inherit",
  },
);
