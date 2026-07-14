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
- [x] [Risk: High] Windows packaged smoke: healthy CUDA runtime transcribes on GPU.
- [x] [Risk: High] Windows packaged smoke: broken CUDA runtime falls back to CPU and still saves a transcript.
- [x] [Risk: Medium] Recovery smoke: existing `.opus` without transcript appears in History and can be retried.
- [ ] [Risk: High] Optional extended pass: `tests/manual/recording-transcription-regression-checklist.md`.
- [ ] [Risk: High] Optional local AI add-ons smoke if models are installed: diarization and summary subset from `tests/manual/local-ai-addons-checklist.md`.

## Next Priorities

Codebase refactor initiative is **complete** (Phases 0–8 + Phase 5B + shared `recorder_stdout`; see section below). Recording awareness Release 1 code is landed; Release 2 Task 10 Steps 1–6 are landed on `feature/long-recording-safety-r2` (durable spool only; flag/RAM path removed). Remaining: commit/PR this branch, optional formal 2 h / 4 h metric tables, Release 1 packaged presence checklist, and release hygiene.

Recommended order when choosing:

1. **Ship R2** — commit/PR `feature/long-recording-safety-r2` after a final `npm test` / `npm run test:python` pass on the integration machine.
2. **Release 1 presence checklist** — packaged macOS/Windows presence checks still open in this file.
3. **Release hygiene** — notarization when enrolled; optional transitive pin / PyObjC trim (needs capture smoke).

Do **not** force Phase 2 renderer controllers now. Revisit only if `app.js` grows materially or a feature forces controller-level changes — and only after (1) a DOM-testing decision and (2) a written Pattern C shared-state ownership plan.

## Next Product Initiative: Recording Awareness And Long-Recording Safety

Implementation plan: `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md` (revised after Fable and follow-up review 2026-07-13).

### Release 1: Recording awareness and discoverability

- [x] [Risk: Medium] Complete Before Coding gates: tray/close snapshot, Windows minimize-while-recording decision, Windows packaged overlay/toast CLSID spike, single-instance collision check, and static saturated macOS recording-status icon validation.
- [x] [Risk: Medium] Add one main-process recording-presence service with a static saturated macOS recording-status icon + `REC` text, supplemental Dock badge, Windows taskbar overlay (minimize while recording so the button remains), and hourly native reminders.
- [x] [Risk: Medium] Publish authoritative `starting` / `recording` / `stopping` / `idle` lifecycle state from `recorder-service.js`, add renderer state hydration, and base elapsed time/reminders on the backend `recording_started` timestamp.
- [x] [Risk: Low] Add an always-visible in-app recording pill and `H:MM:SS` elapsed clock across Record, History, and Settings.
- [x] [Risk: Medium] Add single-instance reveal/focus behavior and recording-specific close copy (Windows: keep recording minimized; macOS: keep in menu bar); keep the existing graceful quit/save path.
- [x] [Risk: Low] Improve descriptive app metadata and validate installed searches for "meeting" or "transcriber" without changing `productName`, Windows shortcut identity, `appId`, `userData`, or release artifacts.
- [ ] [Risk: High] Run packaged macOS and Windows presence checks, including notifications disabled, stop/failure cleanup, display scaling, toast CLSID click-to-open, and installed-app search.

### Release 2: Progressive capture and bounded finalization

- [x] [Risk: Medium] Measure 15-minute and 60-minute capture/stop RSS, duration, and disk baselines; expose structured stop-processing stages, replace shell disk probes (verify Windows `statfs`), and warn periodically when recording space becomes low.
  - Guardrails landed on `feature/long-recording-safety-r2` (statfs probe, 5-minute disk monitor, stdout stop stages, initiative doc). **Hardware 15/60 baselines still pending** in `docs/initiatives/LONG_RECORDING_SAFETY.md`.
- [x] [Risk: High] Add versioned atomic capture manifests and bounded segmented mic/desktop track spools (8 MiB hard cap, soft warning, sustained-stall detection) that cannot be scan-imported as meetings.
- [x] [Risk: High] Integrate Windows timestamp-aware and macOS float32 capture spools behind a temporary rollout flag while preserving desktop-failure behavior.
  - Historical: `AVANEVIS_CAPTURE_SPOOL` gated spool writes until Task 10 Step 6 made durable spools the only path.
- [x] [Risk: High] Replace whole-recording joins/resampling/mixing with bounded multi-pass finalization and recoverable WAV/RF64-to-Opus output.
  - Spool stop path uses `finalize_capture` (`windows-v1` / `macos-v1`); explicit wav muxer for `final.pcm.tmp`; committedFrames boundary; ffmpeg decode verify before cleanup; stable-wav recovery paths.
  - Stop-finalization optimization keeps normalized handles open per pass, folds track stats into normalization, and derives enhance plans from one sum/min/max pass without changing profile decisions. Synthetic timing/RSS harness: `npm run benchmark:finalization`; measured 1 s vs 5 s chunks retained the 1-second default because 5 seconds was not faster and used more RSS.
- [x] [Risk: High] Discover interrupted captures async after window creation, offer `Recover Now` / `Later`, serialize accepted recovery with scan/start through one maintenance gate, complete 2-hour/4-hour hardware evidence, then remove the RAM path and rollout flag.
  - **Task 10 Steps 1–4 landed** (+ two review rounds). **Step 5 done:** Mac + Windows packaged/smoke sign-off (user, 2026-07-14). **Step 6 done:** removed RAM capture path, `AVANEVIS_CAPTURE_SPOOL` flag, and `ChunkedAudioBuffer`; capture always uses durable `{stem}.capture/` spools + `finalize_capture`. Formal 2 h / 4 h metric tables in `LONG_RECORDING_SAFETY.md` still welcome if measured.

## Deferred Product And Architecture Backlog

- [ ] [Risk: High] Acoustic echo cancellation / echo suppression for speaker-use scenarios on Windows and macOS.
- [ ] [Risk: Medium] Upload audio files (`.mp3`, `.wav`, `.opus`) and process them through the transcription, summary, and history flow.
- [ ] [Risk: Medium] History chat over past meetings using the installed local summary runtime/model.
- [ ] [Risk: Medium] Verify the archived "packaged Swift helper skips `which()` when `AVANEVIS_PACKAGED=1`" item is fully implemented and tested; close if redundant with current `test_screencapture_helper.py` coverage.

## Completed: AvaNevis Codebase Refactor

Design doc: `docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md`. Merged through #47 (2026-07-09). Initiative complete; soft-cap accepted for `app.js`.

- [x] Phases 0–8 (characterization → CI/docs), Phase 5B (`hf_runtime` + `audio_prep`), shared `backend/audio/recorder_stdout.py` (#47).
- [x] Phase 2 pure helpers only; **controllers stay deferred** (re-measure: ~4.3k lines; ~600–900 line save still misses ~2k soft-cap; no DOM/controller behavioral tests). Soft-cap acceptance stands.
- [ ] Residual (not blocking initiative exit): Phase 7B macOS capture smoke when Mac hardware is available — `docs/initiatives/phase-0-smoke-baseline.md`.
