# Smart Archive — Roadmap

> Planning document for the maintainer. Current baseline: **v1.20.0** — a mature
> VS Code archive extension (~15k LOC, 310+ tests, clean lint/typecheck, 3-language UI,
> custom-editor archive browser with in-place add/delete/rename/convert/split/merge,
> AES-256, multi-volume, progress + cancellation, WASM 7-Zip with system-tool fast path).
>
> The core feature set is essentially complete. The work below is about **shipping it to
> users, hardening it under load, and closing the few real functional gaps** — not a rewrite.

Legend — **Priority**: 🔴 high · 🟡 medium · 🟢 nice-to-have. **Effort**: S (≤1 day) · M (2–4 days) · L (1–2 weeks).

---

## Phase 1 — Ship it (release & distribution)

The extension builds a `.vsix` and creates a GitHub Release on tag, but it never reaches
the two places users actually install from. This phase turns a private build into a
published product. **This is the highest-leverage phase — everything else is invisible
until users can install it.**

| # | Item | Pri | Effort | Notes |
|---|------|-----|--------|-------|
| 1.1 | **Automated Marketplace + Open VSX publish** in CI on `v*` tags | 🔴 | S | `publish` / `publish:ovsx` scripts already exist — wire them into `build.yml` behind a tag trigger, using `VSCE_PAT` / `OVSX_PAT` repo secrets. Keep the existing artifact + GH Release steps. |
| 1.2 | **`CHANGELOG.md`** (Keep-a-Changelog format) | 🔴 | S | The Marketplace renders CHANGELOG on the extension page; today there is none. Backfill from git history (`generate_release_notes` is already on for GH Releases — reuse that content). |
| 1.3 | **Release checklist / version-bump script** | 🟡 | S | Single command that bumps `package.json`, updates CHANGELOG heading, tags, and pushes. Removes the manual drift between `version`, tag, and changelog. |
| 1.4 | **README polish for Marketplace**: hero GIF, screenshots of the browser, badges (installs, version, rating) | 🟡 | M | The archive browser is the standout feature and it is currently text-only in the README. One good animated GIF of browse → multi-select → extract sells the extension. |
| 1.5 | **Pre-release channel** via `vsce publish --pre-release` | 🟢 | S | Lets power users opt into `main` builds without destabilizing the stable channel. |

**Exit criteria:** a green tag build results in the extension being installable from both
Marketplaces, with a readable changelog and at least one screenshot.

---

## Phase 2 — Performance & robustness under load

All compression/extraction runs on the extension-host thread. For small archives this is
fine; for multi-GB archives the WASM 7-Zip work can stall the host (autocomplete, other
extensions, the UI). Progress + cancellation already exist, which makes the remaining work
tractable.

| # | Item | Pri | Effort | Notes |
|---|------|-----|--------|-------|
| 2.1 | **Move WASM compress/extract to a `worker_threads` worker** | 🔴 | L | The single most impactful reliability change. The engine layer (`src/engines/js7z-*`) is already well-isolated behind `archiveService`; a worker boundary fits the existing seam. Progress/cancel messages marshal across the port. Keep the system-7z (child-process) path as-is since it already runs off-thread. |
| 2.2 | **Large-file benchmark suite** (1 GB / 5 GB / 10 GB fixtures, generated not committed) | 🟡 | M | Guards against regressions in the chunked-I/O / NODEFS paths the README advertises. Run manually / nightly, not on every PR. |
| 2.3 | **Opt-in error reporting** via VS Code `TelemetryLogger` (respecting `telemetry.telemetryLevel`) | 🟡 | M | There is currently zero visibility into real-world failures. Report only classified error codes from `errorClassifier` + format/engine — never paths or filenames. Off unless the user's telemetry setting allows it. |
| 2.4 | **Memory-pressure guardrails**: surface a clear warning before operations that would exceed the configured `maxTotalSize` in RAM, and prefer streaming paths | 🟡 | M | Bomb detection exists; this is the proactive "this will be slow/heavy" heads-up. |
| 2.5 | **Concurrency limit for batch compress** of many small inputs | 🟢 | S | Avoids spawning unbounded work when a user compresses a huge folder tree. |

**Exit criteria:** compressing/extracting a 5 GB archive keeps the VS Code UI responsive;
benchmarks are reproducible.

---

## Phase 3 — Feature gaps

Grounded, high-value additions the current architecture supports. Ordered by user value.

| # | Item | Pri | Effort | Notes |
|---|------|-----|--------|-------|
| 3.1 | **Edit-in-place / save-back**: open a file from the archive, edit it, save → write the changes back into the archive | 🔴 | L | Today `preview.ts` opens files read-only. Save-back is the most-requested capability for archive tools and the `archive/modify.ts` + temp-file plumbing already exists to build on. Guard behind a "reopen from archive" dirty-tracking model. |
| 3.2 | **Drag files from OS / Explorer into the browser** to add them | 🟡 | M | `dropFiles` handler exists — extend it to native drops and VS Code Explorer drags, not just internal moves. Complements the existing add/paste flows. |
| 3.3 | **Explorer quick actions**: "Extract Here" and "Extract to <name>/" as distinct context-menu items | 🟡 | S | Current single "Decompress" always extracts to `<name>.extracted/`. Two explicit choices match every desktop archive tool and are a small `package.json` + command change. |
| 3.4 | **Archive compare / diff** — pick two archives (or an archive vs. a folder) and show added/removed/changed entries | 🟢 | L | Natural extension of the tree-builder; useful for verifying backups and releases. |
| 3.5 | **Nested archive browse** — open an archive-within-an-archive without manual extract | 🟢 | M | The custom editor already keys off virtual entries; nesting reuses the extraction-to-temp path. |
| 3.6 | **Compression tuning UI** — expose dictionary size, solid block, thread count, and per-format method in a quick-pick before compressing | 🟢 | M | Power-user knob; keep the current one-click default untouched so casual users are unaffected. |

**Exit criteria:** edit-save-back ships behind tests; the two extract actions and native
drag-in feel native.

---

## Phase 4 — Engineering quality

Keeps the project maintainable and contributor-friendly as it grows.

| # | Item | Pri | Effort | Notes |
|---|------|-----|--------|-------|
| 4.1 | **Real VS Code integration/E2E tests** with `@vscode/test-electron` | 🔴 | L | The 310 unit tests mock the `vscode` module (`test/__mocks__/vscode.ts`). Nothing exercises the actual custom-editor lifecycle, command registration, or webview messaging in a running VS Code. Add a thin E2E layer for the critical paths (open archive → browse → extract → compress round-trip). |
| 4.2 | **`CONTRIBUTING.md` + architecture note** | 🟡 | S | Document the `engines → services → providers → webview` layering (it is clean but undocumented) so future changes respect the seams that Phase 2/3 depend on. |
| 4.3 | **CI matrix on Windows + macOS** for the native codecs (`zstd-napi`, `lz4-napi`) and system-7z detection | 🟡 | M | `package:cross` handles multi-platform binaries, but tests only run on `ubuntu-latest`. The system-tool detection and path logic are exactly the code most likely to break per-OS. |
| 4.4 | **Coverage reporting** in CI (Vitest `--coverage`) with a non-blocking threshold badge | 🟢 | S | Visibility, not a gate. |
| 4.5 | **Dependency & WASM-binary update cadence** (Dependabot or scheduled job, plus a bump path for js7z-tools / 7-Zip version) | 🟢 | S | js7z tracks upstream 7-Zip; a documented, low-friction bump keeps format support and security current. |

**Exit criteria:** a PR runs unit + E2E tests on all three OSes; contributors have a map of the codebase.

---

## Suggested sequencing

1. **Now (next release):** 1.1, 1.2, 1.4 — get it published with a changelog and screenshots.
2. **Then:** 2.1 (worker thread) + 4.1 (E2E harness) in parallel — the two changes that most
   de-risk everything after them.
3. **Then:** 3.1 (edit-save-back) as the flagship feature of the release after, backed by the
   E2E harness from step 2.
4. **Ongoing:** 4.3 (OS matrix), 2.3 (telemetry), and the 🟢 items as capacity allows.

## Explicitly out of scope (for now)

- Rewriting engines or swapping the WASM 7-Zip core — it works and is fast with the system fast-path.
- Cloud/remote archive sources (S3, etc.) — large surface, unclear demand; revisit if requested.
- Additional _creation_ formats beyond the current 10 — decompression already covers 40+, and
  new create-formats add test/maintenance cost for little gain.