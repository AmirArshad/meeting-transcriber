# Project TODO

Active TODOs only. Completed initiative history lives in git history, `docs/releases/`, and the linked design docs (see "Recently shipped" at the bottom).

## Active: Speakrs Diarization Migration

**Branch:** all implementation on a single branch `feature/speakrs-diarization`, one task at a time, one commit (series) per task prefixed `speakrs task N:`.
**Plan (binding — read first):** [docs/superpowers/plans/2026-07-16-speakrs-diarization-migration.md](docs/superpowers/plans/2026-07-16-speakrs-diarization-migration.md) — frozen CLI contract, execution guardrails, per-task file lists and validation commands.
**Rules that get the best result:** never start task N+1 with task N's validation red; `npm test && npm run test:python` green at every task boundary; everything stays additive until Task 8; if a pinned snapshot test fails before Task 8, the change is wrong — not the snapshot.

- [ ] [Risk: Low] **Task 0a — macOS spike (gate part 1):** build `native/speakrs-cli` (coreml), benchmark 3 internal meetings vs current pyannote MPS, record per-mode model file lists/sizes in `docs/development/SPEAKRS_SPIKE_NOTES.md`. No app code touched.
- [ ] [Risk: Medium] **Task 0b — Windows spike (gate part 2):** CUDA build + prove the full ORT DLL closure against the existing cuda12 profile on real hardware; finish spike tables. **Explicit GO/NO-GO line against the plan's criteria before any app work.**
- [ ] [Risk: Low] **Task 1 pre-step — characterization golden tests first:** pin current `*.speakers.json` schema, `emit_progress` phase sequence, and engine-agnostic IPC handling; commit green against unmodified code. These stay green untouched through Task 7.
- [ ] [Risk: Low] **Task 1 — `speakrs-cli` crate** to the frozen JSON contract + fixture WAV + contract tests. Validation: `cargo test`, `cargo clippy -- -D warnings`, `npm run test:python`.
- [ ] [Risk: Medium] **Task 2 — model pack + catalog:** repack script, `DIARIZATION_ENGINE` constant, `speakrs-community1-vbx` catalog entry (shape sketched in plan), engine-aware status derivation; token-free setup reaches `ready`. Validation: `npm test`.
- [ ] [Risk: Low] **Task 2b — license-compliance checklist** (ATTRIBUTION.md + LICENSES/ inside packs, `THIRD_PARTY_NOTICES.md`, `npm run legal:sbom`). Blocks public release only, not development.
- [ ] [Risk: High] **Task 3 — Python engine dispatch:** `--engine` flag, `backend/diarization/speakrs_runner.py` with guaranteed grandchild kill, identical progress phases, redaction fix at `guided_transcription.py:492`. Validation: `npm run test:python` incl. kill-propagation test.
- [ ] [Risk: High] **Task 4 — main-process plumbing:** spawn env/args, token-free validation path, packaged CLI resolution. Smallest possible diff in `transcription-service.js`; list every touched call site; review this commit extra carefully.
- [ ] [Risk: Medium] **Task 5 — renderer UX + migration:** hide token UI for speakrs, legacy-pyannote migration prompt, explicit legacy cleanup (pip deps + old HF cache + token file, with dialog copy); update `tests/manual/local-ai-addons-checklist.md`.
- [ ] [Risk: Medium] **Task 6 — build/CI/release packaging:** `buildSpeakrsCli` in prepare-resources, extraResources/codesign, CI Rust jobs + CPU-mode fixture smoke, release workflow. Validation: `npm run prepare-build`, packaged smokes, `npm run test:all`. **Merge the branch after this task.**
- [ ] [Risk: High] **Task 7 — soak on merged builds:** benchmark matrix → `docs/development/SPEAKRS_BENCHMARKS.md`; cutover bar = ≥25 internal meetings across both platforms, zero engine crashes/hangs, manual checklist green on packaged Windows CUDA + macOS AS.
- [ ] [Risk: High] **Task 8 — post-soak removal (separate PR, never on the feature branch):** delete pyannote catalog/deps/branches, `needsAccount`, token IPC channels, `--token-stdin`; update every pinned snapshot test in the same PR; rewrite `AGENTS.md` + `docs/development/LOCAL_AI_MODEL_CATALOG.md` diarization sections.

## Release And Dependency Hygiene (carryover)

- [ ] [Risk: Low] Apple Developer signing/notarization: enable when enrolled (`package.json` `mac.notarize`, release workflow secrets).
- [ ] [Risk: Low] Trial dropping other explicit transitive-only pins in a follow-up trim pass (not `onnxruntime`/`tokenizers`/`av` — those stay; see `docs/development/DEPENDABOT_TRIAGE.md`).
- [ ] [Risk: High] Evaluate whether macOS PyObjC `Cocoa` / `Quartz` pins are removable; requires `pip check`, PyObjC import checks, packaged `build:mac:dir`, and ScreenCaptureKit fallback smoke.

## Optional Validation Passes

- [ ] [Risk: High] Extended pass: `tests/manual/recording-transcription-regression-checklist.md`.
- [ ] [Risk: High] Local AI add-ons smoke from `tests/manual/local-ai-addons-checklist.md` (note: checklist gets speakrs rows in Task 5 — prefer running it then).

## Next Priorities

1. **Speakrs diarization migration** (above) — zero-token speaker setup, ~4 GB→~hundreds of MB install, ~20× faster macOS diarization.
2. **Release hygiene** — notarization when enrolled; transitive pin trim; PyObjC Cocoa/Quartz evaluation.
3. **Optional extended checklists** — when convenient (add-ons checklist best after speakrs Task 5).
4. **Next product features** — silent auto-install updater; upload existing audio (reuse Activity queue); see [ROADMAP.md](docs/initiatives/ROADMAP.md).

Do **not** force Phase 2 renderer controllers now. Revisit only if `app.js` grows materially or a feature forces controller-level changes — and only after (1) a DOM-testing decision and (2) a written Pattern C shared-state ownership plan.

## Deferred Product And Architecture Backlog

- [ ] [Risk: High] Acoustic echo cancellation / echo suppression for speaker-use scenarios on Windows and macOS.
- [ ] [Risk: Medium] Upload audio files (`.mp3`, `.wav`, `.opus`) and process them through the transcription, summary, and history flow (reuse the transcription queue / Activity UI).
- [ ] [Risk: Medium] History chat over past meetings using the installed local summary runtime/model.
- [ ] [Risk: Medium] Verify the archived "packaged Swift helper skips `which()` when `AVANEVIS_PACKAGED=1`" item is fully implemented and tested; close if redundant with current `test_screencapture_helper.py` coverage.
- [ ] [Risk: High] Codebase refactor residual: Phase 7B macOS capture smoke when Mac hardware is available — `docs/initiatives/phase-0-smoke-baseline.md`.

## Recently shipped (details in git history / linked docs)

- **v2.6.0** — back-to-back recording & transcription queue (Phase 1 + Phase 2 polish) + cancel-recording discard. Design: `docs/initiatives/FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md`; notes: `docs/releases/v2.6.0.md`.
- **v2.5.0** — recording awareness/presence + progressive capture spools & bounded finalization. Plan: `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md`.
- **Pre-2.6.0 adversarial race hardening**; **macOS arm64 ffmpeg + bundle trim** (~1.3 GB → ~800 MB); **AvaNevis codebase refactor** (merged through #47; soft-cap accepted for `app.js`); **dependency/Dependabot triage** (`docs/development/DEPENDABOT_TRIAGE.md`).
