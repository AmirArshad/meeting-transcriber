# Project TODO

Active TODOs only. Completed dependency-upgrade phase history has been removed from this file; use git history and `docs/development/DEPENDABOT_TRIAGE.md` for background.

## Completed: macOS arm64 ffmpeg + bundle trim (merged)

Replaced Intel-only evermeet.cx ffmpeg with a pinned Apple Silicon static build (fixes macOS 26.4+ Rosetta deprecation warnings). Trimmed the packaged macOS Python runtime by removing `torch` and other MLX-unused PyTorch baggage after `pip install`. Packaged app ~800 MB (down from ~1.3 GB); manual smoke passed (record, Opus encode, MLX transcription, playback).

- [x] [Risk: Low] Pin arm64 ffmpeg download (shaka-project/static-ffmpeg-binaries n8.0.1-1) with SHA-256 verification.
- [x] [Risk: Low] CI: assert bundled `Contents/Resources/ffmpeg/ffmpeg` is arm64 via `file`.
- [x] [Risk: Medium] Post-install removal of `torch` + transitive PyTorch-only packages; keep `scipy` (required by MLX).
- [x] [Risk: Medium] CI packaged smoke: `scripts/verify-macos-packaged-app.sh` (arm64 ffmpeg, codesign, libopus encode, MLX imports, no bundled torch, `du -sh`).
- [x] [Risk: High] Manual macOS smoke: record → Opus via packaged ffmpeg → short MLX transcription on a real Mac.
- [ ] [Risk: Low] Apple Developer signing/notarization: enable when enrolled (`package.json` `mac.notarize`, release workflow secrets).
- [ ] [Risk: High] Evaluate PyObjC `Cocoa` / `Quartz` pin removal (separate follow-up; needs capture smoke).

## Remaining Dependency And Release Hygiene

- [x] [Risk: Low] Close superseded Dependabot PRs that were absorbed by the dependency-upgrade branch: #12 and #20.
- [x] [Risk: Low] Close deferred high-risk Dependabot PRs with explicit comments: #15, #18, and #19.
- [x] [Risk: Medium] Decide whether optional follow-up dependency PRs #13, #14, #16, #17, and #21 should ship as small separate PRs or stay deferred. (Closed; revisit only if Dependabot reopens with newer bumps.)
- [ ] [Risk: Low] Trial dropping explicit transitive-only pins in a follow-up trim pass; keep any pin needed for reproducible packaged builds.
- [ ] [Risk: High] Evaluate whether macOS PyObjC `Cocoa` / `Quartz` pins are removable; requires `pip check`, PyObjC import checks, packaged `build:mac:dir`, and ScreenCaptureKit fallback smoke.
- [x] [Risk: Medium] Remove bundled macOS `torch` after pip install (MLX path does not import it; diarization installs its own torch into userData).
- [ ] [Risk: Medium] Investigate Windows faster-whisper transitive packages such as `onnxruntime`, `tokenizers`, and `av`; remove only if the packaged transcription graph remains valid.

## Remaining Validation And Smoke Checks

- [x] [Risk: High] macOS packaged smoke: launch `dist/mac-arm64/AvaNevis.app` and run a short MLX transcription after `npm run build:mac:dir`.
- [ ] [Risk: High] Windows packaged smoke: healthy CUDA runtime transcribes on GPU.
- [ ] [Risk: High] Windows packaged smoke: broken CUDA runtime falls back to CPU and still saves a transcript.
- [ ] [Risk: Medium] Recovery smoke: existing `.opus` without transcript appears in History and can be retried.
- [ ] [Risk: High] Optional extended pass: `tests/manual/recording-transcription-regression-checklist.md`.
- [ ] [Risk: High] Optional local AI add-ons smoke if models are installed: diarization and summary subset from `tests/manual/local-ai-addons-checklist.md`.

## Deferred Product And Architecture Backlog

- [ ] [Risk: High] Acoustic echo cancellation / echo suppression for speaker-use scenarios on Windows and macOS.
- [ ] [Risk: Medium] Upload audio files (`.mp3`, `.wav`, `.opus`) and process them through the transcription, summary, and history flow.
- [ ] [Risk: Medium] History chat over past meetings using the installed local summary runtime/model.
- [ ] [Risk: High] Stream-to-disk during capture to reduce long-recording memory pressure.
- [ ] [Risk: Medium] Verify the archived "packaged Swift helper skips `which()` when `AVANEVIS_PACKAGED=1`" item is fully implemented and tested; close if redundant with current `test_screencapture_helper.py` coverage.
- [ ] [Risk: Medium] Decide the next feature project after the codebase refactor stabilizes.

## Next: AvaNevis Codebase Refactor

Design doc: `docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md` (amended 2026-07-09 after Fable review).
Branch: `refactor/codebase-phase-4b` (Phase 4 PR B: diarization/summary setup behind Pattern A; after merged PR A #38).

Execution rule: one phase per PR unless the change is purely mechanical and tightly coupled. Prefer Pattern A/B for pure facade moves; use Pattern C (state container + DI) for Phase 3. Move code first, preserve behavior, then improve internals in later PRs. Revert (do not fix forward) any phase that breaks a preserved contract or a manual smoke check. Convert `test:syntax` to a glob in Phase 0; keep new renderer globals uniquely named; target ≤1,500 lines after owning phase (`app.js` soft-cap ~2,000 if helpers alone cannot hit 1,500).

Parallel tracks after Phase 0: main-process JS (1→3), renderer helpers (2), ai-addon-setup (4, may follow Phase 1 immediately), Python (5→6).

- [x] [Risk: Medium] Phase 0: characterization tests + `test:syntax` glob + Windows smoke baseline note. Mechanics: source-scan IPC/compute-queue over `src/main.js` + `src/main/**` (survives Phase 3 moves); facade export snapshots; send-channel snapshot; recorder `audioPath`/`outputPath` emitter asserts; pure-only renderer helper tests (no jsdom). Compute-queue scan (0.2) blocks Phase 3; recorder-event tests (0.4) block Phase 7. Smoke baseline tracker: `docs/initiatives/phase-0-smoke-baseline.md` (Windows run still to date-stamp; macOS scheduled).
- [x] [Risk: Low] Phase 1: split `src/main-process-helpers.js` into domain modules under `src/main-process/` behind the existing facade (Pattern A). May run in parallel with Phase 5 low-risk subset.
- [x] [Risk: Medium] Phase 2: extract low-risk **pure** helpers from `src/renderer/app.js` via Pattern B. Controllers deferred past Phase 3c. Soft-cap accepted: helpers alone leave `app.js` well above 1,500 (~4.9k); do not force controller extraction.
  - [x] PR A: `formatters.js` + `summary-ui-helpers.js` + `ai-addon-ui-helpers.js` (#33).
  - [x] PR B: remaining Pattern-B-safe helpers — `dom-helpers.js` (`clearElement` only), `meeting-helpers.js`, `gpu-settings-helpers.js`, `canvas-helpers.js`. Still deferred (DOM/`document.*`/module state; not verbatim Pattern B without call-site edits): `AudioVisualizer`, `setPlaceholder`/`populateSelect`/`createSvg*`, settings `localStorage` helpers, transcript Markdown renderers, `getSummaryButtonMeetingId`, `setStatusBadge`, `shouldLogAiAddonProgress`.
- [ ] [Risk: High] Phase 2 follow-up (deferred past Phase 3c): extract renderer recording/transcription controllers only if still needed after measuring `app.js` size; prefer soft-cap ~2,000 over a forced controller move.
- [x] [Risk: High] Phase 3a: Pattern C split of lower-risk `src/main.js` services (Python runtime, meeting manager client, device IPC, file export). Created `src/main/python-runtime.js` (owns shared `activeProcesses`), `meeting-manager-client.js`, `device-ipc.js`, `file-export-ipc.js`; `src/main.js` is composition root. Channels/payloads unchanged; preload/renderer untouched. `run-recording-preflight` stays in `main.js`. `main.js` ~5,074 → ~4,156 lines. Automated: `npm test` + `npm run test:python` green. Extra gate (2026-07-09): `build:dir` + path checks + brief packaged launch OK; Windows `npm start` record→transcribe smoke OK. Note (pre-existing UX, not 3a regression): mic/desktop selects stay `disabled` while `isInitializing` until after warm-up + second `device_manager` enum + history scan + CUDA — feels like a slow dropdown; follow-up: enable after `loadAudioDevices` and/or reuse warm-up output to skip the second spawn.
- [x] [Risk: High] Phase 3b: AI/GPU services + behavioral fake-queue compute test; depends on 3a. Extracted `gpu-runtime-service.js`, `ai-compute-queue.js`, `ai-addon-ipc.js` via Pattern C. Recorder/transcription/summary lifecycle stays in `main.js` (3c). `download-model` remains off the compute queue. Behavioral suite: `tests/js/ai-compute-queue.behavioral.test.js` (supplements Phase 0.2 source-scan).
- [x] [Risk: High] Phase 3c: recorder/transcription/summary lifecycle last; gated on Phase 0.2 and 0.4. Extracted `transcription-service.js`, `summary-service.js`, `recorder-service.js` via Pattern C (#37). Fixed unbound `getRecordingsDir` in recorder-service + deps regression test. `download-model` remains off the compute queue. Preload/renderer untouched. macOS smoke still batched with Phase 7 when needed.
- [x] [Risk: Medium] Phase 4: split `src/ai-addon-setup.js` behind facade. Prefer two PRs: (1) manifest/progress/download/archive, (2) diarization-setup + summary-setup. Keep `src/ai-addon-setup.js` as Pattern A facade; preserve export keys + `AI_ADDON_PROGRESS_CHANNEL` / `AI_ADDON_CANCEL_CODE` string values.
  - [x] PR A: `src/ai-addon/{progress-events,download-helpers,manifest-store,archive-install}.js` behind Pattern A facade (#38).
  - [x] PR B: `src/ai-addon/{diarization-setup,summary-setup}.js`; facade thinned to re-exports only; shared `createValidation`/`buildFeatureUpdates` live in `manifest-store.js`.
- [ ] [Risk: Medium] Phase 5: Python common helpers. Low-risk subset may start early alongside Phase 1.
- [ ] [Risk: High] Phase 6: decompose `meeting_manager.py`; keep `MeetingManager` instance methods as monkeypatch seams.
- [ ] [Risk: High] Phase 7: narrow recorder/Swift helper extractions only.
- [ ] [Risk: Medium] Phase 8: CI/docs/architecture cleanup (`test:syntax` glob already done in Phase 0). Optional `refactor-extraction` skill only if agents skip the recipe.
