# AvaNevis Agent Guide

Canonical agent instructions for **Cursor**, **OpenCode**, and **Claude Code**. Update this file when project invariants, architecture, or validation expectations change.

| Tool | How it loads guidance |
|------|------------------------|
| OpenCode | Root `AGENTS.md`, plus scoped Cursor rules via `opencode.json` `instructions` (`.cursor/rules/*.mdc`). Project skills in `.agents/skills/`. |
| Cursor | Root `AGENTS.md` plus scoped rules in `.cursor/rules/`. Root `CLAUDE.md` is listed in `.cursorignore` so it is not double-loaded. Project skills in `.agents/skills/` (also discovers `.cursor/skills/` / `.claude/skills/` if present). |
| Claude Code | Thin root `CLAUDE.md` imports this file with `@AGENTS.md`. Optional path-scoped rules may live under `.claude/rules/`. Project skills: prefer `.agents/skills/` (also reads `.claude/skills/`). |

### Project skills

Reusable Agent Skills live under `.agents/skills/*/SKILL.md` (open standard). They are ordinary markdown folders checked into git — “install” only means copying a skill into that path (see `skills-lock.json` for provenance). Prefer one shared `.agents/skills/` tree over duplicating into per-tool skill directories.

Keep the skill set lean. Do not re-add auto-router skills that claim to run on every conversation (for example Superpowers `using-superpowers` / forced brainstorming / blanket TDD) — they burn tokens and fight this repo’s characterization-first refactor style. Prefer manual or narrowly triggered skills.

## Product Summary

AvaNevis is a privacy-first Electron desktop app for recording microphone audio plus desktop/system audio, then transcribing locally with Whisper.

- Frontend: Electron 42 with plain HTML/CSS/JavaScript
- Backend: Python 3.11 scripts spawned from Electron
- macOS desktop audio: native Swift helper preferred with CoreAudio process tap on macOS 14.2+, Swift/PyObjC ScreenCaptureKit fallback
- Windows transcription: `faster-whisper`
- macOS transcription: `lightning-whisper-mlx` on Apple Silicon, CPU fallback path exists for Intel Macs in dev logic
- Storage: recordings and meeting metadata live in Electron `userData`, not in the repo

## Platform Targets

- Windows: Windows 10/11 x64
- macOS runtime: macOS 13+
- macOS packaged builds: Apple Silicon only (`arm64`)
- Intel Mac note: `src/main.js` contains a `faster-whisper` fallback for Intel Macs, but packaged macOS builds are not targeting Intel

## Architecture Map

### Electron

- `src/main.js`: app lifecycle, tray, startup checks, update checks, and the composition root that instantiates the `src/main/` services
- `src/main/`: extracted main-process services wired from `src/main.js` (Phase 3a–3c). The Phase 0 source-scan tests treat `src/main.js` + `src/main/**/*.js` as one combined main-process surface, so IPC channel names/payloads stay pinned across the split:
  - `src/main/python-runtime.js`: `createPythonRuntime({ app, spawn, path, fs, dirname })` factory that owns the single shared `activeProcesses` tracking array and exposes `getPythonConfig` (aliased `resolvePythonPath`), `pythonConfig` (includes `pythonSource` + resolved `virtualEnv`), `buildPythonProcessArgs`, `buildPythonEnv`, `spawnTrackedPython`, `getActiveProcesses`, `drainActiveProcesses`. Dev resolution: `AVANEVIS_PYTHON` → existing `VIRTUAL_ENV` interpreter → repo `.venv` → system; stale `VIRTUAL_ENV` paths are skipped.
  - `src/main/meeting-manager-client.js`: `registerMeetingManagerClient(ipcMain, deps)` / `createMeetingManagerClient(deps)`; owns `addMeetingToHistory` (used by the quit flow and `add-meeting`) and registers `list-meetings`, `get-meeting`, `delete-meeting`, `scan-recordings`, `add-meeting`, `update-meeting`, `update-meeting-ai`
  - `src/main/device-ipc.js`: `registerDeviceIpc(ipcMain, deps)` / `createDeviceIpc(deps)`; exports `checkDiskSpace` (Node `fs.promises.statfs`; warning <10 GB / critical <2 GB; never auto-stop), `validateSelectedDevices`, `checkAudioOutputSupport`, `getMacOSPermissionStatus` and registers `validate-devices`, `check-disk-space`, `check-audio-output`, `get-audio-devices`, `warm-up-audio-system`, `get-macos-permission-status`
  - `src/main/file-export-ipc.js`: `registerFileExportIpc(ipcMain, deps)` / `createFileExportIpc(deps)`; owns `buildSafeSaveDialogDefaultPath` + `WINDOWS_RESERVED_FILE_BASENAME` and registers `save-transcript-file`, `save-speaker-segments-file`, `save-transcript-as`, `open-legal-notices`
  - `src/main/gpu-runtime-service.js`: `registerGpuRuntimeService(ipcMain, deps)` / `createGpuRuntimeService(deps)`; owns `cachedCudaStatus` / `gpuRuntimeActionPromise` and registers `check-gpu`, `check-cuda`, `install-gpu`, `ensure-compatible-gpu-runtime`, `uninstall-gpu`. Exports `resolveCudaStatusForTranscription` (fresh probe at compute-job start) and `invalidateCachedCudaStatus` (uninstall / failed install).
  - `src/main/ai-compute-queue.js`: `createAiComputeQueue(deps)` (no IPC); owns `aiComputeActionQueue`, `enqueueAiComputeAction`, `waitForAiComputeQueueIdle`, `createAbortableComputeAction`; also exports `createAsyncActionQueue` for the separate `aiAddonActionQueue`
  - `src/main/ai-addon-ipc.js`: `registerAiAddonIpc(ipcMain, deps)` / `createAiAddonIpc(deps)`; owns `diarizationDependencySitePackagesCache` + `aiAddonActionQueue` / setup abort controllers and registers AI add-on status, diarization token, and diarization/summary setup/cancel/validate/remove channels
  - `src/main/transcription-service.js`: `registerTranscriptionService(ipcMain, deps)` / `createTranscriptionService(deps)`; registers `check-model-downloaded`, `download-model` (off compute queue), `transcribe-audio`, `transcribe-audio-with-speakers`, `diarize-transcript`, `retry-transcription`, `finalize-recording-transcription` (pending persist + main-owned composite job), `cancel-pending-transcription`; publishes `transcription-queue-state` (progress attribution via `activeMeetingId`; leave `transcription-progress` string payload unchanged)
  - `src/main/summary-service.js`: `registerSummaryService(ipcMain, deps)` / `createSummaryService(deps)`; owns `activeSummaryGeneration` and registers `generate-summary`, `cancel-summary-generation`; exports quit abort/phase helpers
  - `src/main/recorder-service.js`: `registerRecorderService(ipcMain, deps)` / `createRecorderService(deps)`; owns recording lifecycle state (`pythonProcess`, stop/heartbeat/power-save) and registers `run-recording-preflight`, `start-recording`, `stop-recording`, `get-recording-state`; publishes authoritative `starting`/`recording`/`stopping`/`idle` via optional `onCaptureStateChanged`; exports quit-during-recording helpers for `before-quit`. Quit cancel after `stop` was sent must await/persist the stop result (never claim "recording continues"). `quitCommitted` rejects new `start-recording` / `generate-summary` once a quit drain has begun.
  - `src/main/recording-presence-service.js`: `createRecordingPresenceService(deps)` owns tray presentation, macOS static saturated recording-status icon + `REC` title (call `setTemplateImage(false)` before `setImage`), supplemental Dock badge, Windows taskbar overlay, hourly native reminders (best-effort; never auto-stop on duration), and recording-aware close-dialog copy helpers. Capture truth remains in `recorder-service.js`.
- `src/main-process/`: domain helper modules (compute timeouts, URL/legal, transcription model/runtime, CUDA, AI progress, path safety, recorder output, recording preflight)
- `src/main-process-helpers.js`: facade re-exporting `src/main-process/` helpers; keep the public `module.exports` key set stable for callers and characterization tests
- `src/preload.js`: safe API bridge exposed as `window.electronAPI`
- `src/renderer/app.js`: main UI state machine, settings persistence, meeting history, GPU/settings UI, update banner
- `src/renderer/formatters.js`: pure date/duration/status/byte/progress formatters extracted from `app.js`
- `src/renderer/summary-ui-helpers.js`: pure transcription retry/status predicates for summary UI
- `src/renderer/ai-addon-ui-helpers.js`: pure AI add-on terminal/progress status predicates
- `src/renderer/dom-helpers.js`: element-injected DOM utilities (currently `clearElement`)
- `src/renderer/meeting-helpers.js`: pure meeting id comparison helpers
- `src/renderer/gpu-settings-helpers.js`: pure GPU runtime busy-error predicates
- `src/renderer/canvas-helpers.js`: pure canvas path helpers used by the audio visualizer
- `src/renderer/history-detail-helpers.js`: extracted History tab and AI add-on prompt helpers with JS regression coverage
- `src/renderer/update-notification-helpers.js`: extracted update-banner helpers with JS regression coverage
- `src/renderer/recording-state-helpers.js`: pure recording/transcription UI state helpers with JS regression coverage
- `src/renderer/index.html`: renderer markup
- `src/renderer/styles.css`: renderer styles
- `src/updater.js`: GitHub Releases update checker
- `src/ai-addon-setup.js`: Pattern A facade for local AI add-on setup (manifest, downloads, archives, diarization/summary setup); keep the public `module.exports` key set and `AI_ADDON_PROGRESS_CHANNEL` / `AI_ADDON_CANCEL_CODE` string values stable
- `src/ai-addon/`: Phase 4 domain modules re-exported by the facade — `progress-events.js`, `download-helpers.js`, `manifest-store.js`, `archive-install.js`, `diarization-setup.js`, `summary-setup.js`
- `src/ai-addon-state.js`: catalog pins, paths, manifest normalize/load, availability helpers
- `src/ai-addon-token-store.js`: Hugging Face token in Electron `safeStorage`
- `src/ai-addon-archive-helpers.js`: zip/tar path-traversal guards shared with extractor workers

### Python backend

- `backend/device_manager.py`: enumerate audio devices for UI (CLI/JSON contract unchanged)
- `backend/device_helpers.py`: Phase 5 pure device enumeration helpers (blocklist, record shaping, dedupe, sort, macOS virtual loopback)
- `backend/common/`: shared Python helpers — `sensitive_text.py` (redaction), `hf_runtime.py` (shared `hugging_face_offline_mode`)
- `backend/meeting_manager.py`: persistent meeting history CLI/orchestration (`python -m meeting_manager`); public methods remain instance-method monkeypatch seams
- `backend/meetings/`: Phase 6 helpers — `normalization.py` (status/error/hash/text/metadata parse), `scan_import.py` (scannable audio selection, duration/id parsing), `paths.py` (recordings-path/sidecar safety), `store.py` (FileLock + atomic JSON), `delete_tx.py` (tombstone/rollback delete helpers)
- `backend/check_permissions.py`: macOS permission checks
- `backend/audio/windows_recorder.py`: Windows recording pipeline using `pyaudiowpatch` WASAPI loopback
- `backend/audio/macos_recorder.py`: macOS recording pipeline using `sounddevice` + Swift helper desktop capture with PyObjC fallback
- `backend/audio/recorder_stdout.py`: shared structured stdout emitters (`send_json_message` / `send_event_message` / `send_warning_message` / `send_error_message`); platform recorders keep thin `_send_*` wrappers so Electron contracts stay stable
- `backend/audio/swift_audio_capture.py`: Python bridge to bundled Swift helper; preserves raw PCM stdout and JSON stderr helper contract
- `backend/audio/macos_stereo_repair.py`, `backend/audio/macos_desktop_diagnostics.py`, `backend/audio/macos_stream_alignment.py`: Phase 7 macOS one-sided stereo repair, desktop diagnostics, and mic/desktop start-time alignment (including preroll trim)
- `backend/audio/swift_pcm_alignment.py`, `backend/audio/swift_helper_status.py`: Phase 7 Swift helper float32 alignment + stderr status application
- `backend/audio/processor.py`, `backend/audio/compressor.py`, `backend/audio/wav_io.py`, `backend/audio/timeline.py`, `backend/audio/constants.py`: shared audio processing / compression / WAV I/O helpers used by the platform recorders
- `backend/transcription/formatting.py`: Phase 5 shared transcript timestamp/segment-merge/Markdown helpers used by faster-whisper, MLX, and guided transcription
- `backend/transcription/faster_whisper_transcriber.py`: Windows/default transcriber
- `backend/transcription/mlx_whisper_transcriber.py`: Apple Silicon transcriber
- `backend/diarization/audio_prep.py`: Phase 5B diarization ffmpeg 16 kHz mono prep + in-memory WAV load helpers (re-exported by `diarization_pipeline`)
- `backend/diarization/diarization_pipeline.py`: local pyannote diarization runner and timestamp/speaker merge output
- `backend/diarization/guided_transcription.py`: diarization-first speaker-guided transcription flow using padded speaker turns
- `backend/summaries/sidecar_io.py`: Phase 5 summary sidecar path helpers and atomic JSON/Markdown writers (re-exported by `summary_runner`)
- `backend/summaries/summary_pipeline.py`, `backend/summaries/summary_runner.py`, `backend/summaries/llama_runtime.py`, `backend/summaries/hf_model_downloader.py`: local summary chunking, prompts, JSON validation/repair, Markdown rendering, pinned `llama.cpp` execution, and Hugging Face/Xet-backed summary model downloads

### Native macOS helper

- `swift/AudioCaptureHelper/Package.swift`
- `swift/AudioCaptureHelper/Sources/main.swift`

### Build and release

- `build/download-manifest.js`: pinned build-time download URLs and checksums
- `build/prepare-resources.js`: stages Python/ffmpeg/Swift helper resources, bootstraps pip from a pinned wheel, and invalidates stale prepared resources via `resource-manifest.json`
- `package.json`: Electron builder config and build scripts
- `.github/workflows/ci.yml`: regression tests, syntax checks, packaged-build smoke coverage, and doc validation
- `.github/workflows/build-release.yml`: tagged release builds

## End-to-End Flow

1. Renderer calls `window.electronAPI` from `src/renderer/app.js`.
2. `src/preload.js` forwards calls to `ipcMain.handle(...)` handlers. Most handlers live in Pattern C services under `src/main/` (wired from the composition root in `src/main.js`); a few platform/update channels remain registered directly in `src/main.js`.
3. The owning service (for example `recorder-service.js`, `transcription-service.js`) spawns Python via `python-runtime.js`.
4. Recorder emits:
   - JSON audio level events on stdout
   - structured recorder events/warnings/errors on stdout
   - human-readable debug logs on stderr
   - final JSON result on stdout when recording stops
5. `src/main/recorder-service.js` parses those outputs (helpers in `src/main-process/recorder-output-helpers.js`), updates UI, then saves finished meetings through `backend/meeting_manager.py`.

## Critical Invariants

### Recorder startup and progress use structured stdout JSON

`src/main/recorder-service.js` parses structured stdout messages such as `levels`, `event`, `warning`, and `error` for recorder control flow (via `parseRecorderStdoutChunk`). Helpers live in `src/main-process/recorder-output-helpers.js` (re-exported by `src/main-process-helpers.js`). stderr is debug-only and must not drive startup stages, warnings/errors, or recording-start state.

If you change recorder startup/progress behavior in either recorder:

- `backend/audio/windows_recorder.py`
- `backend/audio/macos_recorder.py`

you must update all of:

- `src/main/recorder-service.js`
- `src/main-process-helpers.js` / `src/main-process/recorder-output-helpers.js`
- `tests/js/main-process-helpers.test.js`
- `tests/js/recorder-event-contract.test.js`

The JSON-event migration in `docs/completed/json-based-events.md` is complete for recorder control flow. Preserve the stdout JSON control contract unless you update both sides together.

### Keep recorder output contracts stable

- Structured stdout messages now include `levels`, `event`, `warning`, and `error`, and `src/main/recorder-service.js` consumes them line-by-line.
- Stop-stage events on both platforms: `post_processing_started`, `audio_normalizing`, `audio_mixing`, `audio_encoding`, `post_processing_complete` (human-readable `message`; forwarded as `recording-progress`). stderr remains diagnostics-only.
- Windows final JSON uses `audioPath`
- macOS final JSON uses `outputPath`
- Stop parsing accepts both for backward compatibility
- Stop/finalize failures must still emit a structured `success:false` result payload (with recoverable `audioPath`/`outputPath` when a final or temp file exists). Do not exit with only a stderr traceback.
- Windows must set `_final_output_path` immediately after compress succeeds, guard temp unlink with `OSError`, and emit the success JSON **before** `cleanup()` (`pa.terminate()`).
- macOS late desktop-capture failures (after a successful start) must warn and continue to mic-only processing; only mic-thread failures are hard stop failures.
- Post-processing temps use a non-scanned `.pcm.tmp` extension (`backend/audio/recorder_temp_paths.py`). Scan-import recovers orphan temps into `{stem}.wav` or deletes them when a final Opus/WAV already exists (`meetings.scan_import.recover_or_cleanup_recorder_temps`). Truncated temps (≤ WAV header size) are dropped, not promoted.
- macOS recovery must promote a leftover `.pcm.tmp` to a stable `{stem}.wav` before emitting `outputPath` — never hand Electron the volatile temp path.
- Live stdout may stash a `result` payload for unexpected-exit recovery; there is no legacy `temp.opus` stop fallback.
- Quit-cancel recovery and a still-pending Stop IPC share one stop result: stop awaits the quit workflow before returning so `alreadyPersistedForQuit` closes the dialog-open race.

Do not casually break this contract unless you update all call sites together.

### Preserve post-processing mix architecture

The app intentionally records mic and desktop audio separately, then mixes after recording stops.

Do not reintroduce real-time mixing unless you are deliberately redesigning the audio pipeline.

**Capture invariant:** both platform recorders always spill raw capture to durable `{stem}.capture/` track spools during recording. Stop finalizes via bounded `finalize_capture` (no whole-session RAM mix). Interrupted sessions recover through `audio.capture_recovery`. Whole-session RAM mix / `MemoryError` on that path is obsolete.

Key quality assumptions to preserve:

- 48 kHz target output
- stereo output
- mono-compatible stereo output for transcription downmixes
- Opus compression via ffmpeg
- gentle mic enhancement instead of aggressive processing
- desktop audio preserved as faithfully as possible
- desktop capture may degrade to mic-only without discarding the microphone recording

### Preserve local-only/privacy-first behavior

- No cloud transcription
- No telemetry or analytics
- No background uploads
- No surprise network dependencies beyond explicit model/update checks and build-time downloads

### Local AI add-ons remain explicit and catalog-driven

- Speaker diarization uses `pyannote/speaker-diarization-community-1` with the user's own Hugging Face token only. Do not embed, proxy, log, or persist a maintainer-owned token.
- Tokens must stay in Electron `safeStorage`; do not write token values to manifests, meeting metadata, transcripts, summaries, progress events, or logs. Diarization setup validation delivers the token via stdin (`--token-stdin`) and clears `HF_TOKEN`, `HUGGINGFACE_HUB_TOKEN`, the deprecated `HUGGING_FACE_HUB_TOKEN` alias, and `HF_TOKEN_PATH` in the child environment so shell-exported tokens cannot leak through `huggingface_hub`. Use `buildClearedHuggingFaceTokenEnv()` for that clearing — never set `HF_TOKEN_PATH` to `""` (huggingface_hub treats that as `Path(".")` and breaks offline pyannote loads). The helper sets `HF_TOKEN_PATH` to `os.devNull`.
- Diarization runs automatically only after transcription when setup is complete and platform policy allows it.
- For new recordings with diarization ready, prefer the diarization-guided transcription path: run pyannote first, build padded speaker windows, transcribe those windows, then save speaker-labeled transcript chunks. If that guided path fails, save a normal transcript and persist diarization error metadata.
- Diarization model refs must be resolved from the catalog in the main process, not trusted from renderer input.
- macOS diarization is Apple Silicon MPS-only; do not add CPU-only macOS diarization as a fallback.
- Summary generation is always user-triggered from Home or History.
- Summary finalization (`phase = 'metadata'`) begins **before** temp→final sidecar renames. Quit/cancel must not abort during that region. After a successful `update-ai` exit, never delete sidecars because of a late abort. The immediate-quit kill loop must spare the metadata-phase `update-ai` process.
- Quit drain (`drainAiWorkBeforeQuit`) sets `quitCommitted` (blocks new recording/summary), notifies the renderer via `app-quit-progress`, **terminates** non-abortable transcription-class compute jobs (does not merely skip waiting), and arms `allowImmediateQuit` inside `finally`. The armed `before-quit` pass re-checks **recording only**; remaining AI/GPU work falls through to force-kill (never re-drain — that looped forever). Pure decision helper: `resolveBeforeQuitAction` in `src/main-process/quit-lifecycle-helpers.js`.
- Summary model and runtime artifacts are pinned and catalog-driven in `src/ai-addon-state.js`; do not hard-code artifact URLs, filenames, checksums, or runtime names in renderer/business logic.
- Summary runtime/model setup must be an explicit user action. No hidden or background summary downloads.
- Summary downloads must stay HTTPS and host-allowlisted, and runtime archive extraction must guard against path traversal.
- Hugging Face-hosted public summary models download through bundled Python `huggingface_hub`/`hf_xet` when available, without reusing the diarization token, and still require pinned SHA-256 verification after download.
- Summary generation and diarization execution must remain serialized through a main-process compute queue to avoid concurrent GPU-heavy local AI runs.
- Meeting AI metadata must accept only `diarization` and `summary`, keep sidecar paths under recordings, and store only concise sanitized strings.
- Completed transcription metadata records the resolved Whisper runtime as `transcriptionDevice` and `transcriptionComputeType` (`cpu`/`cuda`/`mps`). MLX may report `metal` in result JSON; `meeting_manager` accepts that CLI alias and normalizes it to `mps` for persistence. Guided transcription must report the Whisper runtime separately from `diarization.device`, which describes pyannote.
- AI add-on model/runtime caches live under Electron `userData` (`ai-addons/models/...`) so app updates preserve installed artifacts.
- Pinned summary runtime archives extract off the main thread: ZIP via `src/ai-addon-zip-extractor-worker.js`, `tar.gz` via `src/ai-addon-tar-extractor-worker.js`, with shared traversal checks in `src/ai-addon-archive-helpers.js`.

### Transcription model cache and offline runtime

Whisper transcription caches are separate from diarization’s Hugging Face cache under `userData/ai-addons/models/diarization`. Guided transcription must not let diarization `HF_HUB_CACHE` mask the Whisper cache.

**Cache locations**

- Windows / Intel Mac / faster-whisper: `~/.cache/huggingface/hub` (`models--Systran--faster-whisper-<size>` or `models--guillaumekln--faster-whisper-<size>`).
- Apple Silicon MLX: `~/Library/Caches/avanevis/mlx_models/<model-dir>/`.

**Completeness (keep JS and Python aligned)**

- faster-whisper snapshot: non-empty `config.json`, `model.bin`, `tokenizer.json`, plus `vocabulary.txt` or `vocabulary.json`.
- MLX: non-empty `weights.npz` and `config.json` in the model directory.

**Implementation map**

- UI / spawn policy: `cacheContainsCompleteTranscriptionModel` and `buildTranscriptionRuntimeEnv` in `src/main-process-helpers.js`; `getTranscriptionRuntimeEnv` in `src/main/transcription-service.js`.
- Python faster-whisper: `has_cached_faster_whisper_model`, `AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR`, `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY` in `backend/transcription/faster_whisper_transcriber.py`.
- Python MLX: `_required_model_files_cached` in `backend/transcription/mlx_whisper_transcriber.py`.

**Offline behavior**

- Enable HF offline / `local_files_only` only when the cache is **complete** (main sets `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1`; Python may also auto-detect).
- Model download / `--preload` must keep `modelCached: false` so incomplete caches can still download. Preload remains off the compute queue, but shares the composition-root `gpuResourceActionQueue` with admitted compute and GPU package mutation so model loading cannot overlap inference or pip DLL changes.
- Diarization loads pyannote with `local_files_only=True`; summary generation uses `buildHuggingFaceOfflineEnv()` when artifacts are installed.

**Windows CUDA runtime profile**

- Packaged transcription currently supports a CUDA 12 runtime profile (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`) and probes matching DLLs before GPU use.
- If only newer CUDA-major runtime DLLs are detected (for example CUDA 13 DLL names), status should surface a runtime-major mismatch and transcription must remain on safe CPU fallback.
- Transcription GPU setup uses `check-cuda`, `install-gpu` (`mode: install|repair`), and `ensure-compatible-gpu-runtime` (probe → install/repair if needed → re-probe). Transcription CUDA install/repair/uninstall/ensure actions are serialized through a main-process lock with a wall-clock timeout so concurrent base-runtime pip jobs cannot overlap; this is separate from `aiAddonActionQueue` and `aiComputeActionQueue`.

If you change required cache files or env var names, update all of the files above plus `tests/js/main-process-helpers.test.js` and `tests/python/test_transcriber_helpers.py`.

### GPU compute serialization and timeouts

Heavy local AI work runs through a single main-process compute queue (`aiComputeActionQueue` from `src/main/ai-compute-queue.js`, instantiated in `src/main.js`) so only one GPU-heavy job runs at a time.

**Handlers on the compute queue**

- `transcribe-audio`
- `transcribe-audio-with-speakers` (guided diarization-first transcription)
- `diarize-transcript`
- `generate-summary` (generation subprocess only; meeting preflight runs before enqueue)

**Not on the compute queue**

- Whisper model download / preload (`download-model`) — stays **off** the compute queue (must not enqueue), but waits for the compute queue to go idle first (bounded by `AI_COMPUTE_TIMEOUT_MS.modelDownloadIdleWait`) to avoid VRAM contention with transcription/diarization/summary; do not merge downloads onto the compute queue. `cancel-download-model` aborts an in-flight preload (including the idle wait). Non-zero preload exits must re-check cache completeness before reporting success.
- AI add-on setup downloads (`aiAddonActionQueue`) — separate serialization from compute.
- GPU runtime install/repair/uninstall (`gpuRuntimeActionPromise`) — separate lock from the compute queue, but **mutually exclusive with active compute and Whisper preload** through the composition-root `gpuResourceActionQueue`: `runGpuRuntimeAction` waits for compute-queue idle (bounded by `AI_COMPUTE_TIMEOUT_MS.gpuRuntimeComputeIdleWait`) before pip, and admitted compute/preload/runtime actions serialize on the resource queue so pip cannot race loaded CUDA DLLs. The GPU wait runs **inside the enqueued closure but outside** `runWallClockComputeAction`, so a long pip install cannot burn a tiny/base transcription budget. Destructive AI add-on removal rejects while compute/preload/runtime work is pending, then synchronously reserves the same resource queue before deleting files; it must not wait unbounded behind active work or begin later during quit teardown.

**Wall-clock timeouts**

Each enqueued compute job is wrapped with `runWallClockComputeAction` in `src/main-process-helpers.js`, which kills the active child via `terminateProcessBestEffort` when a per-job limit is exceeded. On timeout, the wrapper waits for the child process to exit and for the job promise to settle before releasing the compute queue, with a bounded settle grace (`AI_COMPUTE_TIMEOUT_MS.wallClockSettleGraceMs`) so an unkillable child cannot hold the queue forever.

- Transcription: model-size limits via `getTranscriptionComputeTimeoutMs` (30–120 minutes)
- Speaker identification (diarization): 30 minutes (`AI_COMPUTE_TIMEOUT_MS.diarization`)
- Speaker-guided transcription: `getGuidedTranscriptionComputeTimeoutMs(modelSize)` (model budget from `getGuidedTranscriptionTimeoutMinutes` + 30s margin; the flat `AI_COMPUTE_TIMEOUT_MS.guidedTranscription` is documentation/floor only)
- Summary generation: 90 minutes (`AI_COMPUTE_TIMEOUT_MS.summary`); wall-clock terminate skips the child while `activeSummaryGeneration.phase === 'metadata'` (same exemption as quit). If the outer wall clock still rejects during metadata (hung `update-ai`), clear `activeSummaryGeneration` so later generates are not sticky-locked — sidecars are already committed; never delete them.
- Meeting lookup preflight (`retry-transcription`): 60 seconds (`AI_COMPUTE_TIMEOUT_MS.meetingPreflight`)
- Whisper `download-model` idle wait (off-queue): 15 minutes (`AI_COMPUTE_TIMEOUT_MS.modelDownloadIdleWait`)
- Whisper model preload after admission: 30 minutes (`AI_COMPUTE_TIMEOUT_MS.modelDownload`); slow large-model downloads may need retrying, and partial Hugging Face cache downloads remain resumable.
- GPU runtime vs compute idle wait: 15 minutes (`AI_COMPUTE_TIMEOUT_MS.gpuRuntimeComputeIdleWait`)
- Add-on setup validation (diarization / summary smoke): 15 minutes (`AI_COMPUTE_TIMEOUT_MS.addonValidation`)

Hung children must not stall the queue indefinitely. Preemptive CUDA→CPU decisions for transcription must be evaluated when the queued job **starts**, not at enqueue time — and must **re-probe** via `resolveCudaStatusForTranscription` (not only the 5-minute UI `getCachedCudaStatus` TTL) so a stale/null cache cannot silently skip the CPU UX path. `uninstall-gpu` and failed GPU installs invalidate `cachedCudaStatus`. The faster-whisper / MLX result JSON includes the **actual** `device` (and `computeType` when applicable); main sets `transcriptionDevice` from that field.

**Summary checksum skip (accepted tradeoff)**

`generate-summary` calls `checkAiAddonSetupStatus({ verifyChecksums: true, verifyChecksumsIfChanged: true })`. After the first full SHA-256 match in a process, subsequent generates skip re-hashing when the artifact `path`/`size`/`mtimeMs` fingerprint is unchanged. Setup/validate paths still full-hash. This is a per-session integrity relaxation on an already-locally-trusted file (not a remote vector); a local attacker who replaces the GGUF while preserving size and mtime could bypass the skip. Do not weaken setup/validate full-hash gates.

**Setup validation vs compute**

Diarization and summary setup smoke tests use `createAbortableComputeAction`, which:

1. Blocks on `waitForAiComputeQueueIdle` until `aiComputeActionQueue.hasPendingWork()` is false (no 15s false-failure)
2. Enqueues the validation subprocess on the compute queue so validation cannot overlap transcription, diarization, or summary runs
3. Wraps the validation child in `runWallClockComputeAction` with `AI_COMPUTE_TIMEOUT_MS.addonValidation` so a hung pyannote/llama smoke test cannot wedge the queue

Validation remains user-triggered setup work, not automatic post-transcription behavior. Canceling a summary that is still in preflight or queued (no metadata phase) must clear `activeSummaryGeneration` immediately so the UI is not locked behind a dead queue slot.

## High-Risk Areas

### IPC surface

If you rename or change an IPC handler in the owning `src/main/` service or in `src/main.js`, update `src/preload.js` and every renderer call site in `src/renderer/app.js`.

### Build packaging

If you change bundled runtime locations or prepared-resource inputs, keep these aligned:

- `build/prepare-resources.js`
- `build/download-manifest.js`
- `package.json` `extraResources`
- `src/main.js` runtime path resolution

The generated `build/resources/resource-manifest.json` should continue to invalidate stale prepared resources when those inputs change.

Windows packaged Python relies on `python311._pth` containing `../backend`. Dev mode relies on `PYTHONPATH` setup in `src/main.js`.

Packaged apps set `process.env.AVANEVIS_PACKAGED=1` at main-process startup when `app.isPackaged` (so worker threads inherit it) and also inject it via `buildPythonEnv()` for all spawned Python children. `backend/audio/swift_audio_capture.py` must not call `shutil.which("audiocapture-helper")` when that env var is set — only bundled `Resources/bin/audiocapture-helper` (or explicit dev build paths) are valid. Summary runtime tar extraction (`resolvePreferredTarExecutable`) likewise prefers absolute system tar over PATH when the flag is set. Dev/`npm start` leaves the var unset so PATH lookup still works.

### Meeting metadata persistence

If you change `backend/meeting_manager.py`, preserve:

- `FileLock`-based cross-process locking
- atomic temp-file + `os.replace()` writes
- transactional add behavior that removes originals only after metadata is saved
- corrupt metadata backups named `meetings.corrupt.*.json`
- scan/import preservation of suffixed IDs like `meeting_20260107_104555_1`
- scan/import recorder-temp recovery/cleanup before selecting scannable `.opus`/`.wav` files (never import `.pcm.tmp` / legacy `*.temp.wav` as meetings)

### macOS desktop audio capture

Preferred path is the bundled Swift helper using CoreAudio process taps on macOS 14.2+. The helper falls back to Swift ScreenCaptureKit when CoreAudio tap startup fails or macOS is older; PyObjC ScreenCaptureKit is only a final fallback.

The Swift helper stdout contract is raw interleaved float32 PCM. When a delivery gap is detected after silence (SCK pauses; tap may pause), the helper zero-fills the PCM stream into the **same FIFO** as real audio (before the resuming buffer; capped at 3 minutes) so mid-meeting silence does not collapse and writer starvation cannot reorder fill relative to surrounding samples. Gaps longer than the cap still shift subsequent desktop audio earlier by `(gap − 180s)` — a bounded tradeoff. Gap detection uses the previous buffer's frame count as the expected cadence (not a flat 100ms threshold) and subtracts that duration to avoid +1-buffer over-fill drift. `swift_audio_capture.py` must keep desktop frames as float32 through `samples_to_frames` (no float64 upcast); mixing and one-sided stereo repair in `macos_recorder.py` expect float32-compatible numpy arrays. Helper JSON status, diagnostics, warnings, and errors go to stderr and are parsed by `backend/audio/swift_audio_capture.py`, not directly by Electron. Helper ready wait is 15 seconds; the outer desktop start wait is 20 seconds so a boundary race still surfaces specific helper errors. Stdin EOF stops the helper (no busy-spin orphan). CoreAudio tap start failures that look like System Audio Recording denial include that help string before falling back to ScreenCaptureKit.

CoreAudio can expose tap input as multiple channel buffers even when the stream format is not explicitly marked non-interleaved. Preserve the helper's interleaved stdout normalization and the Python mixer one-sided stereo repair so desktop speech survives MLX/ffmpeg mono transcription downmixing.

Permission behavior differs by backend:

- CoreAudio process tap can require macOS System Audio Recording permission for `com.avanevis.app.audiocapture-helper`.
- ScreenCaptureKit fallback can require Screen Recording permission.
- Preflight (`check_permissions --skip-screen-recording-check`) reports `screen_recording.skipped` / `granted: null` and an unprobed `system_audio_recording` field — it must not claim Screen Recording was granted.
- Do not assume missing desktop audio is a generic Screen Recording issue; inspect `helperCaptureBackend`, helper diagnostics, and unified logs.

If you touch the helper pipeline, verify:

- the helper still builds from `swift/AudioCaptureHelper`
- `build/prepare-resources.js` still copies it to `build/resources/bin`
- codesign/entitlement steps still happen
- `electron-builder` still bundles and signs `Contents/Resources/bin/audiocapture-helper`
- a packaged macOS recording with active Chrome/system audio captures desktop audio and reports `helperCaptureBackend=coreaudio_tap` on macOS 14.2+
- packaged macOS microphone/System Audio Recording permission attribution remains correct with Python recorder children running as POSIX process-group leaders
- browser/YouTube speech appears in the transcript, not only in the desktop audio meter or saved stereo channel

### Release asset naming

`src/updater.js` identifies installers by filename patterns.

If you change artifact naming in `package.json` or `.github/workflows/build-release.yml`, update `src/updater.js` too.

## Important Repo Facts

- Root `AGENTS.md` is the single source of truth for agent guidance. Root `CLAUDE.md` is a thin Claude Code bridge (`@AGENTS.md` only); keep it out of Cursor context via `.cursorignore`. Do not paste a full duplicate of this file into `CLAUDE.md`.
- CI now includes backend tests, build/download-manifest tests, main-process and renderer helper JS tests, plus Windows/macOS packaged-build smoke checks, but it is still not full end-to-end product coverage.
- Root `README.md` and `docs/development/` are kept aligned with the post-refactor layout; prefer this file for cross-process invariants when docs disagree.
- `backend/meeting_manager.py` now uses locked atomic metadata writes, transactional add behavior, and corrupt-file backups.
- Transcript Save As is shipped (`save-transcript-as` IPC via `src/main/file-export-ipc.js`); the renderer uses Electron's native save dialog for `.md` / `.txt` export.

## Commands That Reflect The Actual Repo

### Install

```bash
npm install
```

Use platform-specific Python requirements for local development:

```bash
# Windows
py -3.11 -m pip install -r requirements-windows.txt -r requirements-dev.txt

# macOS
python3 -m pip install -r requirements-macos.txt -r requirements-dev.txt
```

### Run

```bash
npm start
npm run dev
```

### Build

```bash
npm run prepare-build
npm run build
npm run build:dir
npm run build:mac
npm run build:mac:dir
```

### Swift helper only

```bash
swift build -c release --arch arm64
```

Run that inside `swift/AudioCaptureHelper`.

### Test suite

```bash
npm test
npm run test:python
npm run test:all
```

- `npm test`: JS regression tests plus `test:syntax` glob (`node --check` over all `.js` under `src/`)
- `npm run test:python`: cross-platform Python unit-test wrapper for `tests/python`
- `npm run test:python-syntax`: recursive `compileall` over `backend/` (covers `meetings/`, `summaries/`, `diarization/`, `common/`, …)
- `npm run test:all`: JS + Python unit tests + Python syntax check
- Characterization gates for the codebase refactor: IPC/compute-queue source-scan and facade export snapshots under `tests/js/`; recorder stdout contracts under `tests/js/recorder-event-contract.test.js` and `tests/python/test_recorder_event_contract.py`
- Manual recorder validation checklist lives in `tests/manual/recording-smoke-checklist.md`
- Setup instructions for new machines live in `docs/development/TESTING.md`
- Targeted adversarial review prompts (one risk area per session): `docs/development/ADVERSARIAL_REVIEW_PROMPTS.md`

### CI-style validation

```bash
npm test
npm run test:python
npm run test:python-syntax
python backend/device_manager.py
```

On macOS, also validate the helper still builds:

```bash
swift build -c release --arch arm64
```

## What To Validate After Changes

### Recorder or device changes

- device enumeration still works
- recording startup still resolves correctly
- audio level updates still reach the renderer
- stop flow still returns a valid output path
- meeting history still saves usable audio/transcript files
- relevant automated tests still pass
- manual smoke checklist still passes on the affected platform

### Transcription changes

- model preload still works
- transcript JSON shape still matches renderer expectations
- markdown transcript output still saves correctly
- CPU/GPU fallback behavior still makes sense for the platform
- complete-cache detection stays aligned between `src/main-process-helpers.js` and `backend/transcription/faster_whisper_transcriber.py` / MLX cache checks
- guided transcription still passes `AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR` when diarization HF env is present
- relevant automated tests still pass

### Local AI add-on changes

- status still reflects `notConfigured`, `needsAccount`, `downloading`, `validating`, `ready`, `error`, and `unsupported`
- diarization setup never exposes token values and uses only the user's token
- Windows speaker prompts remain behind CUDA readiness when NVIDIA/CUDA is the target path
- macOS speaker setup remains hidden/unsupported until accelerated diarization is validated
- summaries remain user-triggered and never modify transcripts on failure
- summary setup refuses unpinned, checksum-mismatched, unallowed-host, or unsafe runtime archive artifacts
- summary setup cancellation kills in-progress downloader subprocesses and removes partial setup files without deleting previously valid installs
- summary/diarization generation remains serialized and cannot launch overlapping GPU-heavy backends
- summary output saves `*.summary.json` and `*.summary.md` and metadata stores only concise sidecar references
- stale summaries are detectable through `sourceTranscriptHash`
- relevant JS and Python regression tests pass

### Meeting history changes

- duplicate IDs are still prevented
- scan/import still avoids re-adding persisted files
- scan/import still preserves suffixed IDs
- delete still handles Windows file locking gracefully
- corrupt metadata recovery still creates `meetings.corrupt.*.json` backups when needed
- meeting manager tests still pass

### Build/release changes

- `npm run prepare-build` still stages Python/ffmpeg correctly
- macOS helper still lands in bundled resources
- updater can still detect release assets by filename
- CI still runs the regression suite successfully

## Common Change Patterns

### If you change recorder process output

Update all of:

- recorder stdout/stderr output
- `src/main/recorder-service.js` parser / stop-result logic
- `src/main-process/recorder-output-helpers.js` (and facade re-exports)
- `tests/js/recorder-event-contract.test.js` and related helper tests
- any renderer UI states that depend on that progress

### If you change saved meeting file names or locations

Update all of:

- recorder output path logic (`recorder_temp_paths.py`, both platform recorders, compressor input-format handling)
- `backend/meeting_manager.py`
- scan/import logic (`meetings/scan_import.py` temp recovery + scannable selection)
- delete logic
- any renderer assumptions about playback paths
- `tests/python/test_recorder_temp_and_scan_recovery.py` and related meeting-manager scan tests

### If you change model download behavior

Update all of:

- `src/main.js`
- renderer first-time setup flow in `src/renderer/app.js`
- transcriber preload CLI behavior
- build logic if bundled/offline behavior changes

### If you change local AI model catalog or runtime pins

Update all of:

- `src/ai-addon-state.js`
- `src/ai-addon-setup.js` if cache/setup semantics change
- `docs/development/LOCAL_AI_MODEL_CATALOG.md`
- `todo.md` model-default notes if product defaults change
- relevant JS tests under `tests/js/ai-addon-*.test.js`

## Known Maintenance Hotspots

- `src/main.js`: composition root (~1.7k lines) for lifecycle, quit drain, tray, and service wiring — still easy to regress via quit/compute-queue or path-resolution changes
- `src/renderer/app.js`: still the largest hotspot (~5k lines); UI state machine with many implicit assumptions (Phase 2 controller extraction deferred)
- `src/main/recorder-service.js` / `transcription-service.js` / related services: own most IPC and subprocess orchestration after the Phase 3 split
- `backend/audio/windows_recorder.py`: timing-sensitive, sample-rate-sensitive, callback-sensitive
- `backend/audio/macos_recorder.py`: threading plus native helper integration plus permission edge cases
- `build/prepare-resources.js`: packaging-critical and platform-specific

## Guidance For Future Refactors

- Prefer extracting logic behind stable interfaces instead of rewriting whole flows.
- Keep platform-specific behavior explicit rather than hiding it behind overly clever abstractions.
- Preserve user-facing resilience: many handlers intentionally degrade gracefully instead of hard-failing.
- When simplifying code, preserve the current operational behavior first, then reduce complexity.
- Keep `todo.md` updated whenever task status changes, major progress is made, or execution order is adjusted.

## Agent Efficiency Defaults

- Work inline by default. Do not delegate routine inspection, small edits, focused tests, or plan self-review to subagents.
- Ask before launching a subagent. Use one only for an explicitly requested independent review or a high-risk cross-process, concurrency, persistence, packaging, security, or platform boundary.
- Do not re-review the same work after feedback unless a material design or implementation change introduces a new risk.
- Keep plans concise and file-level by default. Add per-step TDD scripts, commit instructions, or handoff workflow only when explicitly requested or needed for high-risk behavior.
- Start validation with the smallest relevant test command. Run the full suite only for cross-cutting, recorder, persistence, packaging, security, or explicitly requested validation.

## When In Doubt

- Trust the current runtime scripts and CI over stale docs.
- Inspect both Electron and Python sides before changing any cross-process contract.
- Favor targeted, low-risk edits over architecture rewrites unless the task explicitly calls for a redesign.
