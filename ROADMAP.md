# Roadmap

Maintainer planning doc. Baseline: **v2.5.0** — mature (~25k LOC, 794+ tests, 3-language UI, archive browser with in-place add/delete/rename, AES-256, multi-volume, WASM compress/extract on `worker_threads`, WASM 7-Zip with system-tool fast path). Core features are complete — remaining work is **shipping, hardening, closing small gaps**, not a rewrite.

Legend — **Pri:** 🔴 high · 🟡 medium · 🟢 nice-to-have. **Effort:** S ≤1d · M 2–4d · L 1–2w.

## Phase 1 — Ship it

Publish to where users actually install from. **Highest leverage — everything else is invisible until then.** (Tag builds already produce a VSIX + GitHub Release.)

| # | Item | Pri | Effort |
|---|------|-----|--------|
| 1.1 | Marketplace + Open VSX publish in CI on `v*` tags (`vsce`/`ovsx`, `VSCE_PAT`/`OVSX_PAT` secrets) | 🔴 | S |
| 1.2 | `CHANGELOG.md` (Keep-a-Changelog), backfilled from git history | 🔴 | S |
| 1.3 | Release script: bump version + changelog heading + tag + push (removes manual drift) | 🟡 | S |
| 1.4 | README polish for Marketplace: hero GIF, browser screenshots, badges | 🟡 | M |
| 1.5 | Pre-release channel (`vsce publish --pre-release`) | 🟢 | S |

**Exit:** a green tag build is installable from both marketplaces with a changelog and screenshot.

## Phase 2 — Performance & robustness

WASM compress/extract already runs off the host thread; remaining work is benchmarking, observability, and edge-case robustness.

| # | Item | Pri | Effort |
|---|------|-----|--------|
| 2.2 | Large-file benchmark suite (1/5/10 GB fixtures, generated not committed) | 🟡 | M |
| 2.3 | Opt-in error reporting via `TelemetryLogger` (classified error codes only, never paths) | 🟡 | M |

**Exit:** compressing/extracting a 5 GB archive keeps the VS Code UI responsive.

## Phase 3 — Feature gaps

Grounded additions the current architecture supports, ordered by user value.

| # | Item | Pri | Effort |
|---|------|-----|--------|
| 3.1 | Edit-in-place / save-back into the archive (most-requested; `modify.ts` + temp-file plumbing exists) | 🔴 | L |
| 3.2 | Drag files from OS / Explorer into the browser | 🟡 | M |
| 3.3 | "Extract Here" quick action (the "Extract to…" folder-picker already shipped, opt-in) | 🟡 | S |
| 3.4 | Archive compare / diff (two archives, or archive vs folder) | 🟢 | L |
| 3.5 | Nested archive browse (archive-within-archive) | 🟢 | M |
| 3.6 | Compression tuning UI (dictionary, solid block, threads) | 🟢 | M |

**Exit:** save-back ships tested; "Extract Here" and drag-in feel native.

## Phase 4 — Engineering quality

| # | Item | Pri | Effort |
|---|------|-----|--------|
| 4.1 | VS Code integration/E2E tests with `@vscode/test-electron` (today ~794 unit tests mock `vscode`; nothing exercises the real custom-editor lifecycle) | 🔴 | L |
| 4.2 | `CONTRIBUTING.md` + architecture note (`engines → services → providers → webview` layering) | 🟡 | S |
| 4.3 | Unit tests for system-7z detection / path logic on Windows + macOS (CI already validates Windows pure-fs and the bundled mac 7zz binary) | 🟡 | M |
| 4.4 | Coverage reporting in CI (non-blocking) | 🟢 | S |

**Exit:** a PR runs unit + E2E tests on all three OSes; contributors have a codebase map.

## Sequencing

1. **Next release:** 1.1, 1.2, 1.4 — published with changelog and screenshots.
2. **Then:** 4.1 (E2E harness) — the biggest de-risker.
3. **Then:** 3.1 (edit-save-back) as the next flagship, backed by the E2E harness.
4. **Ongoing:** 4.3, 2.3, and 🟢 items as capacity allows.

## Out of scope (for now)

- Engine rewrites / swapping the WASM 7-Zip core — it works and is fast with the system fast-path.
- Cloud/remote archive sources (S3, etc.) — large surface, unclear demand.
- New *creation* formats — extract already covers 40+, and new ones add test/maintenance cost for little gain.
