# Project TODO

Active TODOs only. Completed dependency-upgrade phase history has been removed from this file; use git history and `docs/development/DEPENDABOT_TRIAGE.md` for background.

## Active: macOS arm64 ffmpeg + bundle trim (`fix/macos-arm64-ffmpeg-and-bundle-trim`)

Replace Intel-only evermeet.cx ffmpeg with a pinned Apple Silicon static build (fixes macOS 26.4+ Rosetta deprecation warnings). Trim the packaged macOS Python runtime by removing `torch` and other MLX-unused PyTorch baggage after `pip install` (MLX transcription does not import `torch_whisper.py`).

- [x] [Risk: Low] Pin arm64 ffmpeg download (shaka-project/static-ffmpeg-binaries n8.0.1-1) with SHA-256 verification.
- [x] [Risk: Low] CI: assert bundled `Contents/Resources/ffmpeg/ffmpeg` is arm64 via `file`.
- [x] [Risk: Medium] Post-install removal of `torch` + transitive PyTorch-only packages; keep `scipy` (required by MLX).
- [ ] [Risk: High] macOS packaged smoke: record → Opus via arm64 ffmpeg → short MLX transcription (CI now verifies arm64 arch, codesign, and `ffmpeg -version` spawn).
- [ ] [Risk: Medium] Measure `du -sh build/resources/python` before/after on a Mac build host; update `docs/completed/INSTALLER_SIZE_NOTES.md`.
- [ ] [Risk: High] Evaluate PyObjC `Cocoa` / `Quartz` pin removal (separate follow-up; needs capture smoke).

## Remaining Dependency And Release Hygiene

- [ ] [Risk: Low] Close superseded Dependabot PRs that were absorbed by the dependency-upgrade branch: #12 and #20.
- [ ] [Risk: Low] Close deferred high-risk Dependabot PRs with explicit comments: #15, #18, and #19.
- [ ] [Risk: Medium] Decide whether optional follow-up dependency PRs #13, #14, #16, #17, and #21 should ship as small separate PRs or stay deferred.
- [ ] [Risk: Low] Trial dropping explicit transitive-only pins in a follow-up trim pass; keep any pin needed for reproducible packaged builds.
- [ ] [Risk: High] Evaluate whether macOS PyObjC `Cocoa` / `Quartz` pins are removable; requires `pip check`, PyObjC import checks, packaged `build:mac:dir`, and ScreenCaptureKit fallback smoke.
- [x] [Risk: Medium] Remove bundled macOS `torch` after pip install (MLX path does not import it; diarization installs its own torch into userData).
- [ ] [Risk: Medium] Investigate Windows faster-whisper transitive packages such as `onnxruntime`, `tokenizers`, and `av`; remove only if the packaged transcription graph remains valid.

## Remaining Validation And Smoke Checks

- [ ] [Risk: High] macOS packaged smoke: launch `dist/mac-arm64/AvaNevis.app` and run a short MLX transcription after `npm run build:mac:dir`.
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

Design doc: `docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md`.

Execution rule: one phase per PR unless the change is purely mechanical and tightly coupled. Move code first, preserve behavior, then improve internals in later PRs. Revert (do not fix forward) any phase that breaks a preserved contract or a manual smoke check. Add every new JS entry file to `test:syntax`, keep new renderer globals uniquely named, and target no source file over 1,500 lines after its owning phase.

- [ ] [Risk: Medium] Phase 0: add characterization tests for IPC contracts, compute queue membership, renderer helper behavior, and recorder stdout event shapes. Compute-queue tests (0.2) block Phase 3; recorder-event tests (0.4) block Phase 7.
- [ ] [Risk: Low] Phase 1: split `src/main-process-helpers.js` into smaller domain modules behind the existing facade. May run in parallel with the Phase 5 low-risk subset.
- [ ] [Risk: Medium] Phase 2: extract low-risk helpers from `src/renderer/app.js`, including visualizer, formatters, DOM helpers, settings helpers, transcript rendering, summary UI, AI add-on UI, and GPU UI helpers. Extend existing `recording-state-helpers.js` / `history-detail-helpers.js` / `update-notification-helpers.js` rather than duplicating.
- [ ] [Risk: High] Phase 2 follow-up: extract renderer recording and transcription controllers only after helper coverage is in place.
- [ ] [Risk: High] Phase 3a: split lower-risk `src/main.js` handlers (Python runtime, meeting manager client, device IPC, file export IPC) into services with explicit dependency injection.
- [ ] [Risk: High] Phase 3b: split AI/GPU surface (GPU runtime, AI compute queue, AI add-on IPC) into services; depends on Phase 3a.
- [ ] [Risk: High] Phase 3c: split recorder/transcription lifecycle (transcription, summary, recorder) into services last; gated on Phase 0.2 and 0.4 tests.
- [ ] [Risk: Medium] Phase 4: split `src/ai-addon-setup.js` into manifest, progress, download, archive, diarization setup, and summary setup modules while preserving the exported facade.
- [ ] [Risk: Medium] Phase 5: extract Python common helpers for transcription formatting, structured events, device normalization, diarization audio prep, and summary sidecar IO. The low-risk subset (formatting, sidecar IO, device normalization) may start early alongside Phase 1.
- [ ] [Risk: High] Phase 6: decompose `backend/meeting_manager.py` into metadata normalization, safe paths, scan/import, locked JSON storage, and delete transaction helpers.
- [ ] [Risk: High] Phase 7: clean recorder and Swift helper internals only through narrow behavior-preserving extractions.
- [ ] [Risk: Medium] Phase 8: update build, CI, syntax checks (convert `test:syntax` to a glob), architecture docs, and validation docs for the new module layout.
