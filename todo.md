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
- [ ] [Risk: Low] Trial dropping *other* explicit transitive-only pins in a follow-up trim pass (not `onnxruntime`/`tokenizers`/`av` — those stay); keep any pin needed for reproducible packaged builds.
- [ ] [Risk: High] Evaluate whether macOS PyObjC `Cocoa` / `Quartz` pins are removable; requires `pip check`, PyObjC import checks, packaged `build:mac:dir`, and ScreenCaptureKit fallback smoke.
- [x] [Risk: Medium] Remove bundled macOS `torch` after pip install (MLX path does not import it; diarization installs its own torch into userData).
- [x] [Risk: Medium] Investigate Windows faster-whisper transitive packages `onnxruntime`, `tokenizers`, and `av`: **keep explicit pins** in `requirements-windows-build.txt`. All three are hard deps of `faster-whisper==1.2.1`; AvaNevis uses `vad_filter=True` (onnxruntime/Silero), path-based decode (PyAV/`av`), and Whisper tokenization (`tokenizers`). Do not remove from packaged Windows builds. See 2026-07-14 note in `docs/development/DEPENDABOT_TRIAGE.md`.

## Remaining Validation And Smoke Checks

- [x] [Risk: High] macOS packaged smoke: launch `dist/mac-arm64/AvaNevis.app` and run a short MLX transcription after `npm run build:mac:dir`.
- [x] [Risk: High] Windows packaged smoke: healthy CUDA runtime transcribes on GPU.
- [x] [Risk: High] Windows packaged smoke: broken CUDA runtime falls back to CPU and still saves a transcript.
- [x] [Risk: Medium] Recovery smoke: existing `.opus` without transcript appears in History and can be retried.
- [ ] [Risk: High] Optional extended pass: `tests/manual/recording-transcription-regression-checklist.md`.
- [ ] [Risk: High] Optional local AI add-ons smoke if models are installed: diarization and summary subset from `tests/manual/local-ai-addons-checklist.md`.

## Next Priorities

Codebase refactor, Release 1 presence, and Release 2 long-recording safety shipped in **v2.5.0** (merged to `master`).

**Next big product initiative:** [Back-to-back recording & transcription queue](docs/initiatives/FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md) (design locked after adversarial review; [before/after SVG](docs/architecture/background-transcription-queue-before-after.svg)).

Recommended order when choosing:

1. **Back-to-back recording & transcription queue (Phase 1)** — main-owned pending persist + compute jobs; Home Activity list; Start unlocks after save. See section below.
2. **Release hygiene** — notarization when enrolled; trial other transitive pin trim (not `onnxruntime`/`tokenizers`/`av`); PyObjC Cocoa/Quartz evaluation.
3. **Optional extended checklists** — full transcription regression / local AI add-ons smoke when convenient.

Do **not** force Phase 2 renderer controllers now. Revisit only if `app.js` grows materially or a feature forces controller-level changes — and only after (1) a DOM-testing decision and (2) a written Pattern C shared-state ownership plan. The transcription-queue work will touch `app.js` but should extract helpers / keep main owning the job — not a full controller rewrite.

## Next Product Initiative: Back-to-Back Recording & Transcription Queue

Design: `docs/initiatives/FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md`  
Diagram: `docs/architecture/background-transcription-queue-before-after.svg`

**Problem:** After Stop, Start stays blocked through encode *and* full Whisper (renderer `transcribing` state), so consecutive meetings wait minutes. Encode must stay exclusive; transcription must not block capture.

**Phase 1 (MVP) — ship as two PRs: PR 1 = main-owned job behind current blocking UI (behavior-identical); PR 2 = unlock + Activity UI. Cancel recording is an independent companion PR (PR 3).**

**PR1 in progress** on `feature/transcription-queue-pr1` (architecture move; Start still blocked until PR2).

- [ ] [Risk: High] Stop → `addMeeting(pending)` + placeholder transcript (incl. recoverable-failure path); snapshot language/model; use post-add `audioPath`. If pending persist itself fails: surface error, stay idle, rely on scan-import recovery (audio already in recordings dir). *(PR1)*
- [ ] [Risk: High] Main-owned per-meeting composite job on `aiComputeActionQueue` (`retry-transcription` shape: transcribe → optional diarize → persist). Renderer becomes a view — do not “just remove the await.” **Includes moving guided-sidecar / `update-meeting-ai` persistence into the main job** (today the renderer persists sidecars after retry returns — background completion during reload/quit would lose speaker metadata). *(PR1)*
- [ ] [Risk: Medium] Durable statuses only: `pending` | `failed` | `completed`. Never persist `processing` (would coerce to completed). User cancel → `failed` + "Cancelled by user" (never left `pending` — resume must not nag). *(PR1 guards; cancel UX in PR2)*
- [ ] [Risk: Medium] `transcription-queue-state` channel; **leave `transcription-progress` payload unchanged** (pinned IPC contract) — renderer attributes lines via `activeMeetingId`. Home Activity list (Queued / Transcribing / Failed+Retry / Cancel pending / session-only Ready → History). *(channel in PR1; Activity UI in PR2)*
- [ ] [Risk: Medium] Unlock Start immediately after pending persist; button copy → **Stop** / Saving… (stop-stage messages); status pill `Ready · N transcribing`. *(PR2)*
- [ ] [Risk: Medium] Quit: terminate active job; meetings stay `pending`; quit copy says they finish next launch (never “quit will wait”). **Two job-level guards:** every job checks `quitCommitted`/cancel flag at head-of-queue (else chained queue starts the next Whisper run mid-quit); quit-killed jobs skip the write-`failed` path (`isQuitCommitted()` in catch) so they stay resumable and don’t spawn `meeting_manager` during teardown. *(job guards PR1; quit copy PR2)*
- [ ] [Risk: Low] Explicit “Resume N pending transcriptions” banner (no auto-resume in Phase 1). *(PR2)*
- [ ] [Risk: High] Recording-while-CPU-transcribe contention: transcription/diarization children **self-lower to below-normal priority unconditionally at startup** (ctypes `SetPriorityClass` / `os.nice` — not spawn-time, not capture-conditional); optional `cpu_threads` cap / defer past `starting`; manual smoke item. *(priority self-lower in PR1)*
- [ ] [Risk: Medium] GPU install / model preload: fail-fast when queue non-idle (15-minute idle waits become routinely exceedable). *(PR2)*
- [ ] [Risk: Medium] Delete/cancel-while-queued: cancel flag at head (same primitive as the quit check); no artifact write after tombstone; active-job delete policy documented. *(cancel flag PR1; delete UX PR2)*
- [ ] [Risk: High] Characterization + targeted tests; Windows/macOS smoke: back-to-back Start while previous job transcribes. *(PR1 tests; smoke with PR2 unlock)*

**Companion PR — Cancel recording (discard); see design doc “Companion feature” section**

- [ ] [Risk: High] New `cancel` stdin command in both recorders; tighten stdin parse to exact-token (current `"stop" in line.lower()` is substring match); skip Stage A entirely; emit structured `{success: true, cancelled: true}` final JSON (never stderr-only exit).
- [ ] [Risk: High] Tombstone-ordered spool discard: write `discarded` marker to capture manifest **first**, then best-effort delete spools/temps; `capture_recovery` + scan-import treat marked captures as cleanup-only (no resurrection). Crash before marker → recovers as normal interrupted recording (safe default).
- [ ] [Risk: Medium] `recorder-service.js` cancel path: publishes capture state, resolves to idle, never calls `addMeetingToHistory`/enqueue; stop/cancel mutually exclusive (first command wins; cancel after `stop` rejected). Discard UI only while `recording`/countdown (never during `stopping`), always confirms, not adjacent-clickable with Stop.
- [ ] [Risk: High] Recorder contract test updates per AGENTS.md list (JS + Python event-contract tests, `recorder-output-helpers`, manual smoke: cancel mid-recording both platforms; relaunch shows no recovered meeting).

**Phase 2 (polish) — after Phase 1 ships**

- [ ] [Risk: Medium] Auto-resume `pending` post recordings-maintenance scan (never auto-resume `failed`).
- [ ] [Risk: Low] Completion toasts (duration-based copy); first-run tip; soft queue-depth warning.
- [ ] [Risk: Medium] Between-job GPU/preload admission if fail-fast is too painful.
- [ ] [Risk: Low] Richer phase text / optional percent on active row.

**Cut until asked:** tray “Transcribing N”; inline Home transcript drawer; teaching button label; encode time estimates.

## Completed: Recording Awareness And Long-Recording Safety (v2.5.0)

Implementation plan: `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md`. Shipped in **v2.5.0**.

### Release 1: Recording awareness and discoverability

- [x] [Risk: Medium] Complete Before Coding gates: tray/close snapshot, Windows minimize-while-recording decision, Windows packaged overlay/toast CLSID spike, single-instance collision check, and static saturated macOS recording-status icon validation.
- [x] [Risk: Medium] Add one main-process recording-presence service with a static saturated macOS recording-status icon + `REC` text, supplemental Dock badge, Windows taskbar overlay (minimize while recording so the button remains), and hourly native reminders.
- [x] [Risk: Medium] Publish authoritative `starting` / `recording` / `stopping` / `idle` lifecycle state from `recorder-service.js`, add renderer state hydration, and base elapsed time/reminders on the backend `recording_started` timestamp.
- [x] [Risk: Low] Add an always-visible in-app recording pill and `H:MM:SS` elapsed clock across Record, History, and Settings.
- [x] [Risk: Medium] Add single-instance reveal/focus behavior and recording-specific close copy (Windows: keep recording minimized; macOS: keep in menu bar); keep the existing graceful quit/save path.
- [x] [Risk: Low] Improve descriptive app metadata and validate installed searches for "meeting" or "transcriber" without changing `productName`, Windows shortcut identity, `appId`, `userData`, or release artifacts.
- [x] [Risk: High] Run packaged macOS and Windows presence checks, including notifications disabled, stop/failure cleanup, display scaling, toast CLSID click-to-open, and installed-app search.

### Release 2: Progressive capture and bounded finalization

- [x] [Risk: Medium] Measure 15-minute and 60-minute capture/stop RSS, duration, and disk baselines; expose structured stop-processing stages, replace shell disk probes (verify Windows `statfs`), and warn periodically when recording space becomes low.
  - Guardrails landed on `feature/long-recording-safety-r2` (statfs probe, 5-minute disk monitor, stdout stop stages, initiative doc). Hardware 15/60 baselines and presence/smoke evidence signed off (user, 2026-07-14).
- [x] [Risk: High] Add versioned atomic capture manifests and bounded segmented mic/desktop track spools (8 MiB hard cap, soft warning, sustained-stall detection) that cannot be scan-imported as meetings.
- [x] [Risk: High] Integrate Windows timestamp-aware and macOS float32 capture spools behind a temporary rollout flag while preserving desktop-failure behavior.
  - Historical: `AVANEVIS_CAPTURE_SPOOL` gated spool writes until Task 10 Step 6 made durable spools the only path.
- [x] [Risk: High] Replace whole-recording joins/resampling/mixing with bounded multi-pass finalization and recoverable WAV/RF64-to-Opus output.
  - Spool stop path uses `finalize_capture` (`windows-v1` / `macos-v1`); explicit wav muxer for `final.pcm.tmp`; committedFrames boundary; ffmpeg decode verify before cleanup; stable-wav recovery paths.
  - Stop-finalization optimization keeps normalized handles open per pass, folds track stats into normalization, and derives enhance plans from one sum/min/max pass without changing profile decisions. Synthetic timing/RSS harness: `npm run benchmark:finalization`; measured 1 s vs 5 s chunks retained the 1-second default because 5 seconds was not faster and used more RSS.
- [x] [Risk: High] Discover interrupted captures async after window creation, offer `Recover Now` / `Later`, serialize accepted recovery with scan/start through one maintenance gate, complete 2-hour/4-hour hardware evidence, then remove the RAM path and rollout flag.
  - **Task 10 complete on branch** (Steps 1–6 + review fix). Hardware smoke / presence / long-recording evidence signed off (user, 2026-07-14).

## Deferred Product And Architecture Backlog

- [ ] [Risk: High] Acoustic echo cancellation / echo suppression for speaker-use scenarios on Windows and macOS.
- [ ] [Risk: Medium] Upload audio files (`.mp3`, `.wav`, `.opus`) and process them through the transcription, summary, and history flow (should reuse the transcription queue / Activity UI once that ships).
- [ ] [Risk: Medium] History chat over past meetings using the installed local summary runtime/model.
- [ ] [Risk: Medium] Verify the archived "packaged Swift helper skips `which()` when `AVANEVIS_PACKAGED=1`" item is fully implemented and tested; close if redundant with current `test_screencapture_helper.py` coverage.

## Completed: AvaNevis Codebase Refactor

Design doc: `docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md`. Merged through #47 (2026-07-09). Initiative complete; soft-cap accepted for `app.js`.

- [x] Phases 0–8 (characterization → CI/docs), Phase 5B (`hf_runtime` + `audio_prep`), shared `backend/audio/recorder_stdout.py` (#47).
- [x] Phase 2 pure helpers only; **controllers stay deferred** (re-measure: ~4.3k lines; ~600–900 line save still misses ~2k soft-cap; no DOM/controller behavioral tests). Soft-cap acceptance stands.
- [ ] Residual (not blocking initiative exit): Phase 7B macOS capture smoke when Mac hardware is available — `docs/initiatives/phase-0-smoke-baseline.md`.
