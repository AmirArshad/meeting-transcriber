# Project TODO

Active TODOs only. Completed initiative history lives in git history, `docs/releases/`, and the linked design docs (see "Recently shipped" at the bottom).

## Active: Speakrs Diarization Migration

**Branch:** all implementation on a single branch `feature/speakrs-diarization`, one task at a time, one commit (series) per task prefixed `speakrs task N:`.
**Plan (binding — read first):** [docs/superpowers/plans/2026-07-16-speakrs-diarization-migration.md](docs/superpowers/plans/2026-07-16-speakrs-diarization-migration.md) — **v5**. Exclusive user selector (both engines stay). Frozen CLI contract, delete lists, copy, defaults. speakrs **0.5.0**. Mac packaged soak 2026-08-14: setup/CoreML path works; selector UX + 2-talker over-cluster are Task 7a. Task 7a **code** landed 2026-08-14 (Switch model, `[hidden]` CSS, radios re-enabled after setup). Same-audio Mac 10:22 still outstanding; Windows CUDA shorts did not reproduce +1 speaker. Packaged re-smoke still required.
**Rules that get the best result:** never start task N+1 with task N's validation red; `npm test && npm run test:python` green at every task boundary; additive (pyannote stays); if a pinned snapshot test fails, the change is wrong — not the snapshot. **No Task 7 flip. Task 8 parked.** New users default **speakrs**; existing pyannote stays until they switch. Only one engine on disk.

- [x] [Risk: Low] **Task 0a — macOS spike (tables only, no GO):** rustc 1.88+; speakrs 0.5.0 with `default-features=false`, `default-linalg`+`coreml`, `online` off; `ExecutionMode::CoreMl` (not the CPU example); record `required_files(CoreMl)` from source + sizes; 3 internal meetings vs pyannote MPS; CLI + combined RSS; notes in `docs/development/SPEAKRS_SPIKE_NOTES.md`. No app code touched. Pinned VoxConverse n=10 DER smoke **PASS** (Δ +0.53 / +0.43).
- [x] [Risk: Medium] **Task 0b — Windows spike (gate):** `default-linalg`+`cuda`+`load-dynamic`; ORT **1.27.1** cuda12 + existing cuda12 pip (cublas/cudnn) on RTX 4070 / driver 610.88 — GPU run **PASS**. VoxConverse Δ **+2.96 / +2.82** and RTFx **0.56×** pyannote CUDA miss the written bars. **CONDITIONAL GO** (DLL closure holds; do not claim Windows speed/DER win).
- [x] [Risk: Low] **Task 1 pre-step — characterization golden tests** (may land in parallel with 0a): pin `*.speakers.json` field sets + today's `annotationSource` values, `emit_progress` **per entry point**, engine-agnostic payload **shape** (not full argv). Green against unmodified code; stay green through Task 7.
- [x] [Risk: Low] **Task 1 — `speakrs-cli` crate** to the frozen JSON contract (`annotationSource` = `exclusive_speaker_diarization`) + fixture WAV + contract tests. Features: always keep `default-linalg`. Validation: `cargo test`, `cargo clippy -- -D warnings`, `npm run test:python`.
- [x] [Risk: Medium] **Task 2 — model pack + catalog:** published the approved, reproducible Windows/macOS archives in the dedicated [`speakrs-models-5d24ffe-r1`](https://github.com/AmirArshad/meeting-transcriber/releases/tag/speakrs-models-5d24ffe-r1) model-artifact release and pinned their exact public URLs, SHA-256 values, and sizes. Adversarial hardening covers precedence, repair cancellation, exclusive deletion, contained paths, fail-closed Windows DLL integrity, packaged CLI resolution, token-free Speakrs, selective/cancelable extraction, exact pyannote removal, and redacted progress. Full automated validation and the Windows RTX 4070 public-download/setup + CUDA fixture smoke pass; macOS Apple Silicon setup smoke remains hardware-required.
- [x] [Risk: Low] **Task 2b — license-compliance checklist:** both packs include `ATTRIBUTION.md` plus complete `LICENSES/`; notices are mirrored in `THIRD_PARTY_NOTICES.md`, nested prepared-resource staging is covered, and `npm run legal:sbom` is current.
- [x] [Risk: High] **Task 3 — Python engine dispatch:** `--engine` flag, `speakrs_runner.py` with CLI in the **same** POSIX process group (no `start_new_session`), inner progress phases only, no torch assert on speakrs path, redaction fix at `guided_transcription.py:492`. Validation: `npm run test:python` incl. kill-propagation test.
- [x] [Risk: High] **Task 4 — main-process plumbing:** `--engine` from manifest; speakrs env + Windows ORT PATH; token-free validation branch (keep pyannote `--token-stdin`). Packaged CLI pinned to `Resources/bin` (no PATH/decoy fallback). Speakrs children drop ambient HF caches after `buildPythonEnv` merge; packaged `AVANEVIS_PACKAGED=1` is non-overridable. Do not require `runtime.modelRef`.
- [x] [Risk: Medium] **Task 5 — selector UI + exclusive switch:** two cards (Mac Speakrs **Recommended**); confirm + delete the other engine; hide token UI for speakrs; hide speaker-count; checklist rows for switch both ways. No new IPC channel (`setup-diarization({ engine })`). Packaged missing bundled CLI: user-facing reinstall copy before Python spawn (not “re-run setup”).
- [x] [Risk: Medium] **Task 6 — build/CI/release packaging:** `buildSpeakrsCli`, extraResources/codesign, fixture WAV, CI Rust + CPU smoke (Windows `cuda,load-dynamic` compile-only). Validation: `npm run prepare-build`, `npm run test:all`. **Merge after this task; both engines selectable.** Windows packaging verification 2026-08-13: `cargo test`/`clippy`/`build --target x86_64-pc-windows-msvc`, CPU-smoke (6 segments, `device=cpu`), `npm run test:all`, `build:dir` + `verify-speakrs-packaging.js --packaged`, and `--verify-pack-checksums` all green. ffmpeg 8.0.1 pin retargeted to Gyan GitHub (`packages/` 404, same SHA-256). macOS dir/CoreML and Windows CUDA inference were not re-run here.
- [x] [Risk: High] **Adversarial remediations (post-Task 6, before merge):** pin extracted Windows ORT DLLs to catalog/spec hashes (never `install.json`) and full-hash changed fingerprints at queued compute admission; packaged CLI/fixture fail-closed integrity also drives status readiness; cancellation after artifact commit cannot restore unvalidated `ready`; target-engine local preflight before exclusive delete; isolated timeout-grace timer cleanup; pin Speakrs GitHub Actions to reviewed commit SHAs. Task 7 soak/README/benchmarks and Task 8 stay parked.
- [ ] [Risk: High] **Task 7 — soak on merged builds:** no default flip; README speaker-ID **8 GB min / 16 GB recommended** + Windows ~823 MB disk note (**README updated 2026-08-14**); benchmarks → `docs/development/SPEAKRS_BENCHMARKS.md`; bar = ≥25 meetings (≥10/OS), Mac 2×50-turn A/B ≤ +2, selector/switch checklist green. **Mac 2026-08-14:** packaged dir build Ready + CoreML guided (no crash). Selector checklist **not** green until packaged re-smoke of Task 7a. Speakrs 35 s in-room+YouTube clip reported **3** speakers vs pyannote **2** on a same-morning 26 s clip of the same kind. Windows CUDA soak still outstanding.
- [ ] [Risk: Medium] **Task 7a — selector UX + Mac quality follow-up (blocking ship bar):** Settings/Home button **Switch model** when the other engine is installed (not Set Up). Root cause of Speakrs→Pyannote: `setAiAddonControlsDisabled(true)` left engine radios disabled after setup; radios now follow `canSelectEngine`. `.ai-addon-field[hidden] { display: none }` so token + Speakers dropdown hide on Speakrs. Speakrs stays auto-only (0.5.0 has no speaker-count API). **Token keep on switch (2026-08-14):** Pyannote→Speakrs no longer deletes the Hugging Face token; empty token field reuses it on switch-back; Remove still deletes it. **Docs/legal (2026-08-14):** README, AGENTS, About credits, and `THIRD_PARTY_NOTICES.md` name Speakrs alongside pyannote. Mac 10:22 same-audio A/B still outstanding (files on Mac). Windows CUDA shorts 2026-08-14: Speakrs `speakerCount` matched pyannote (no +1 over-cluster); more exclusive turns possible. Windows 11:17 soak: 2 speakers, closing mic turn clustered as the YouTube speaker (split identity, not remapping). Validation: `npm test` + packaged Mac/Windows checklist rows.
- [ ] [Risk: High] **Task 8 — PARKED:** do not delete pyannote / token IPC. Not on this branch.

## Release And Dependency Hygiene (carryover)

- [ ] [Risk: Low] Apple Developer signing/notarization: enable when enrolled (`package.json` `mac.notarize`, release workflow secrets).
- [ ] [Risk: Low] Trial dropping other explicit transitive-only pins in a follow-up trim pass (not `onnxruntime`/`tokenizers`/`av` — those stay; see `docs/development/DEPENDABOT_TRIAGE.md`).
- [x] [Risk: Low] Absorb Dependabot #73/#72/#58: `filelock` 3.32.0, `certifi` 2026.7.22, `typing-extensions` 4.16.0, `ctranslate2` 4.8.1. Windows transcription smoke passed. Close those PRs after this lands.
- [ ] [Risk: High] Evaluate whether macOS PyObjC `Cocoa` / `Quartz` pins are removable; requires `pip check`, PyObjC import checks, packaged `build:mac:dir`, and ScreenCaptureKit fallback smoke.

## Optional Validation Passes

- [ ] [Risk: High] Extended pass: `tests/manual/recording-transcription-regression-checklist.md`.
- [ ] [Risk: High] Local AI add-ons smoke from `tests/manual/local-ai-addons-checklist.md` (note: checklist gets speakrs rows in Task 5 — prefer running it then).

## Next Priorities

1. **Speakrs diarization migration** (above) — Task 7a code is in; packaged Mac re-smoke + Windows CUDA soak next. No silent cutover.
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
