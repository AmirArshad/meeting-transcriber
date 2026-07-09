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
  - `src/main/python-runtime.js`: `createPythonRuntime({ app, spawn, path, fs, dirname })` factory that owns the single shared `activeProcesses` tracking array and exposes `getPythonConfig` (aliased `resolvePythonPath`), `pythonConfig`, `buildPythonProcessArgs`, `buildPythonEnv`, `spawnTrackedPython`, `getActiveProcesses`, `drainActiveProcesses`
  - `src/main/meeting-manager-client.js`: `registerMeetingManagerClient(ipcMain, deps)` / `createMeetingManagerClient(deps)`; owns `addMeetingToHistory` (used by the quit flow and `add-meeting`) and registers `list-meetings`, `get-meeting`, `delete-meeting`, `scan-recordings`, `add-meeting`, `update-meeting`, `update-meeting-ai`
  - `src/main/device-ipc.js`: `registerDeviceIpc(ipcMain, deps)` / `createDeviceIpc(deps)`; exports `checkDiskSpace`, `validateSelectedDevices`, `checkAudioOutputSupport`, `getMacOSPermissionStatus` and registers `validate-devices`, `check-disk-space`, `check-audio-output`, `get-audio-devices`, `warm-up-audio-system`, `get-macos-permission-status`
  - `src/main/file-export-ipc.js`: `registerFileExportIpc(ipcMain, deps)` / `createFileExportIpc(deps)`; owns `buildSafeSaveDialogDefaultPath` + `WINDOWS_RESERVED_FILE_BASENAME` and registers `save-transcript-file`, `save-speaker-segments-file`, `save-transcript-as`, `open-legal-notices`
  - `src/main/gpu-runtime-service.js`: `registerGpuRuntimeService(ipcMain, deps)` / `createGpuRuntimeService(deps)`; owns `cachedCudaStatus` / `gpuRuntimeActionPromise` and registers `check-gpu`, `check-cuda`, `install-gpu`, `ensure-compatible-gpu-runtime`, `uninstall-gpu`
  - `src/main/ai-compute-queue.js`: `createAiComputeQueue(deps)` (no IPC); owns `aiComputeActionQueue`, `enqueueAiComputeAction`, `waitForAiComputeQueueIdle`, `createAbortableComputeAction`; also exports `createAsyncActionQueue` for the separate `aiAddonActionQueue`
  - `src/main/ai-addon-ipc.js`: `registerAiAddonIpc(ipcMain, deps)` / `createAiAddonIpc(deps)`; owns `diarizationDependencySitePackagesCache` + `aiAddonActionQueue` / setup abort controllers and registers AI add-on status, diarization token, and diarization/summary setup/cancel/validate/remove channels
  - `src/main/transcription-service.js`: `registerTranscriptionService(ipcMain, deps)` / `createTranscriptionService(deps)`; registers `check-model-downloaded`, `download-model` (off compute queue), `transcribe-audio`, `transcribe-audio-with-speakers`, `diarize-transcript`, `retry-transcription`
  - `src/main/summary-service.js`: `registerSummaryService(ipcMain, deps)` / `createSummaryService(deps)`; owns `activeSummaryGeneration` and registers `generate-summary`, `cancel-summary-generation`; exports quit abort/phase helpers
  - `src/main/recorder-service.js`: `registerRecorderService(ipcMain, deps)` / `createRecorderService(deps)`; owns recording lifecycle state (`pythonProcess`, stop/heartbeat/power-save) and registers `run-recording-preflight`, `start-recording`, `stop-recording`; exports quit-during-recording helpers for `before-quit`
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
- `backend/meeting_manager.py`: persistent meeting history in `meetings.json`, dedupe, scan/import, delete with retry
- `backend/check_permissions.py`: macOS permission checks
- `backend/audio/windows_recorder.py`: Windows recording pipeline using `pyaudiowpatch` WASAPI loopback
- `backend/audio/macos_recorder.py`: macOS recording pipeline using `sounddevice` + Swift helper desktop capture with PyObjC fallback
- `backend/audio/swift_audio_capture.py`: Python bridge to bundled Swift helper; preserves raw PCM stdout and JSON stderr helper contract
- `backend/audio/processor.py`, `backend/audio/compressor.py`, `backend/audio/timeline.py`, `backend/audio/constants.py`: Windows audio processing modules
- `backend/transcription/formatting.py`: Phase 5 shared transcript timestamp/segment-merge/Markdown helpers used by faster-whisper, MLX, and guided transcription
- `backend/transcription/faster_whisper_transcriber.py`: Windows/default transcriber
- `backend/transcription/mlx_whisper_transcriber.py`: Apple Silicon transcriber
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
2. `src/preload.js` forwards calls to `ipcMain.handle(...)` handlers in `src/main.js`.
3. `src/main.js` spawns Python recorder/transcriber processes.
4. Recorder emits:
   - JSON audio level events on stdout
   - structured recorder events/warnings/errors on stdout
   - human-readable debug logs on stderr
   - final JSON result on stdout when recording stops
5. Electron parses those outputs, updates UI, then saves finished meetings through `backend/meeting_manager.py`.

## Critical Invariants

### Recorder startup and progress use structured stdout JSON

`src/main.js` parses structured stdout messages such as `levels`, `event`, `warning`, and `error` for recorder control flow. stderr is debug-only and must not drive startup stages, warnings/errors, or recording-start state.

If you change recorder startup/progress behavior in either recorder:

- `backend/audio/windows_recorder.py`
- `backend/audio/macos_recorder.py`

you must update all of:

- `src/main.js`
- `src/main-process-helpers.js`
- `tests/js/main-process-helpers.test.js`

The JSON-event migration in `docs/completed/json-based-events.md` is complete for recorder control flow. Preserve the stdout JSON control contract unless you update both sides together.

### Keep recorder output contracts stable

- Structured stdout messages now include `levels`, `event`, `warning`, and `error`, and `src/main.js` consumes them line-by-line.
- Windows final JSON uses `audioPath`
- macOS final JSON uses `outputPath`
- `src/main.js` currently supports both for backward compatibility

Do not casually break this contract unless you update all call sites together.

### Preserve post-processing mix architecture

The app intentionally records mic and desktop audio separately, then mixes after recording stops.

Do not reintroduce real-time mixing unless you are deliberately redesigning the audio pipeline.

Key quality assumptions to preserve:

- 48 kHz target output
- stereo output
- mono-compatible stereo output for transcription downmixes
- Opus compression via ffmpeg
- gentle mic enhancement instead of aggressive processing
- desktop audio preserved as faithfully as possible

### Preserve local-only/privacy-first behavior

- No cloud transcription
- No telemetry or analytics
- No background uploads
- No surprise network dependencies beyond explicit model/update checks and build-time downloads

### Local AI add-ons remain explicit and catalog-driven

- Speaker diarization uses `pyannote/speaker-diarization-community-1` with the user's own Hugging Face token only. Do not embed, proxy, log, or persist a maintainer-owned token.
- Tokens must stay in Electron `safeStorage`; do not write token values to manifests, meeting metadata, transcripts, summaries, progress events, or logs.
- Diarization runs automatically only after transcription when setup is complete and platform policy allows it.
- For new recordings with diarization ready, prefer the diarization-guided transcription path: run pyannote first, build padded speaker windows, transcribe those windows, then save speaker-labeled transcript chunks. If that guided path fails, save a normal transcript and persist diarization error metadata.
- Diarization model refs must be resolved from the catalog in the main process, not trusted from renderer input.
- macOS diarization is Apple Silicon MPS-only; do not add CPU-only macOS diarization as a fallback.
- Summary generation is always user-triggered from Home or History.
- Summary model and runtime artifacts are pinned and catalog-driven in `src/ai-addon-state.js`; do not hard-code artifact URLs, filenames, checksums, or runtime names in renderer/business logic.
- Summary runtime/model setup must be an explicit user action. No hidden or background summary downloads.
- Summary downloads must stay HTTPS and host-allowlisted, and runtime archive extraction must guard against path traversal.
- Hugging Face-hosted public summary models download through bundled Python `huggingface_hub`/`hf_xet` when available, without reusing the diarization token, and still require pinned SHA-256 verification after download.
- Summary generation and diarization execution must remain serialized through a main-process compute queue to avoid concurrent GPU-heavy local AI runs.
- Meeting AI metadata must accept only `diarization` and `summary`, keep sidecar paths under recordings, and store only concise sanitized strings.
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

- UI / spawn policy: `cacheContainsCompleteTranscriptionModel` and `buildTranscriptionRuntimeEnv` in `src/main-process-helpers.js`; `getTranscriptionRuntimeEnv` in `src/main.js`.
- Python faster-whisper: `has_cached_faster_whisper_model`, `AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR`, `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY` in `backend/transcription/faster_whisper_transcriber.py`.
- Python MLX: `_required_model_files_cached` in `backend/transcription/mlx_whisper_transcriber.py`.

**Offline behavior**

- Enable HF offline / `local_files_only` only when the cache is **complete** (main sets `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1`; Python may also auto-detect).
- Model download / `--preload` must keep `modelCached: false` so incomplete caches can still download.
- Diarization loads pyannote with `local_files_only=True`; summary generation uses `buildHuggingFaceOfflineEnv()` when artifacts are installed.

**Windows CUDA runtime profile**

- Packaged transcription currently supports a CUDA 12 runtime profile (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`) and probes matching DLLs before GPU use.
- If only newer CUDA-major runtime DLLs are detected (for example CUDA 13 DLL names), status should surface a runtime-major mismatch and transcription must remain on safe CPU fallback.
- Transcription GPU setup uses `check-cuda`, `install-gpu` (`mode: install|repair`), and `ensure-compatible-gpu-runtime` (probe → install/repair if needed → re-probe). Transcription CUDA install/repair/uninstall/ensure actions are serialized through a main-process lock with a wall-clock timeout so concurrent base-runtime pip jobs cannot overlap; this is separate from `aiAddonActionQueue` and `aiComputeActionQueue`.

If you change required cache files or env var names, update all of the files above plus `tests/js/main-process-helpers.test.js` and `tests/python/test_transcriber_helpers.py`.

### GPU compute serialization and timeouts

Heavy local AI work runs through a single main-process compute queue (`aiComputeActionQueue` in `src/main.js`) so only one GPU-heavy job runs at a time.

**Handlers on the compute queue**

- `transcribe-audio`
- `transcribe-audio-with-speakers` (guided diarization-first transcription)
- `diarize-transcript`
- `generate-summary` (generation subprocess only; meeting preflight runs before enqueue)

**Not on the compute queue**

- Whisper model download / preload (`download-model`) — must remain off-queue so downloads can proceed while transcription is idle or blocked behind other work; do not merge with the compute queue.
- AI add-on setup downloads (`aiAddonActionQueue`) — separate serialization from compute.

**Wall-clock timeouts**

Each enqueued compute job is wrapped with `runWallClockComputeAction` in `src/main-process-helpers.js`, which kills the active child via `terminateProcessBestEffort` when a per-job limit is exceeded. On timeout, the wrapper waits for the child process to exit and for the job promise to settle before releasing the compute queue.

- Transcription: model-size limits via `getTranscriptionComputeTimeoutMs` (30–120 minutes)
- Speaker identification (diarization): 30 minutes (`AI_COMPUTE_TIMEOUT_MS.diarization`)
- Speaker-guided transcription: 120 minutes (`AI_COMPUTE_TIMEOUT_MS.guidedTranscription`)
- Summary generation: 90 minutes (`AI_COMPUTE_TIMEOUT_MS.summary`)

Hung children must not stall the queue indefinitely.

**Setup validation vs compute**

Diarization and summary setup smoke tests use `createAbortableComputeAction`, which:

1. Blocks on `waitForAiComputeQueueIdle` until `aiComputeActionQueue.hasPendingWork()` is false (no 15s false-failure)
2. Enqueues the validation subprocess on the compute queue so validation cannot overlap transcription, diarization, or summary runs

Validation remains user-triggered setup work, not automatic post-transcription behavior.

## High-Risk Areas

### IPC surface

If you rename or change an IPC handler in `src/main.js`, update `src/preload.js` and every renderer call site in `src/renderer/app.js`.

### Build packaging

If you change bundled runtime locations or prepared-resource inputs, keep these aligned:

- `build/prepare-resources.js`
- `build/download-manifest.js`
- `package.json` `extraResources`
- `src/main.js` runtime path resolution

The generated `build/resources/resource-manifest.json` should continue to invalidate stale prepared resources when those inputs change.

Windows packaged Python relies on `python311._pth` containing `../backend`. Dev mode relies on `PYTHONPATH` setup in `src/main.js`.

Packaged apps set `AVANEVIS_PACKAGED=1` in `buildPythonEnv()` (`src/main.js`) for all spawned Python children. `backend/audio/swift_audio_capture.py` must not call `shutil.which("audiocapture-helper")` when that env var is set — only bundled `Resources/bin/audiocapture-helper` (or explicit dev build paths) are valid. Dev/`npm start` leaves the var unset so PATH lookup still works.

### Meeting metadata persistence

If you change `backend/meeting_manager.py`, preserve:

- `FileLock`-based cross-process locking
- atomic temp-file + `os.replace()` writes
- transactional add behavior that removes originals only after metadata is saved
- corrupt metadata backups named `meetings.corrupt.*.json`
- scan/import preservation of suffixed IDs like `meeting_20260107_104555_1`

### macOS desktop audio capture

Preferred path is the bundled Swift helper using CoreAudio process taps on macOS 14.2+. The helper falls back to Swift ScreenCaptureKit when CoreAudio tap startup fails or macOS is older; PyObjC ScreenCaptureKit is only a final fallback.

The Swift helper stdout contract is raw interleaved float32 PCM. `swift_audio_capture.py` must keep desktop frames as float32 through `samples_to_frames` (no float64 upcast); mixing and one-sided stereo repair in `macos_recorder.py` expect float32-compatible numpy arrays. Helper JSON status, diagnostics, warnings, and errors go to stderr and are parsed by `backend/audio/swift_audio_capture.py`, not directly by Electron.

CoreAudio can expose tap input as multiple channel buffers even when the stream format is not explicitly marked non-interleaved. Preserve the helper's interleaved stdout normalization and the Python mixer one-sided stereo repair so desktop speech survives MLX/ffmpeg mono transcription downmixing.

Permission behavior differs by backend:

- CoreAudio process tap can require macOS System Audio Recording permission for `com.avanevis.app.audiocapture-helper`.
- ScreenCaptureKit fallback can require Screen Recording permission.
- Do not assume missing desktop audio is a generic Screen Recording issue; inspect `helperCaptureBackend`, helper diagnostics, and unified logs.

If you touch the helper pipeline, verify:

- the helper still builds from `swift/AudioCaptureHelper`
- `build/prepare-resources.js` still copies it to `build/resources/bin`
- codesign/entitlement steps still happen
- `electron-builder` still bundles and signs `Contents/Resources/bin/audiocapture-helper`
- a packaged macOS recording with active Chrome/system audio captures desktop audio and reports `helperCaptureBackend=coreaudio_tap` on macOS 14.2+
- browser/YouTube speech appears in the transcript, not only in the desktop audio meter or saved stereo channel

### Release asset naming

`src/updater.js` identifies installers by filename patterns.

If you change artifact naming in `package.json` or `.github/workflows/build-release.yml`, update `src/updater.js` too.

## Important Repo Facts

- Root `AGENTS.md` is the single source of truth for agent guidance. Root `CLAUDE.md` is a thin Claude Code bridge (`@AGENTS.md` only); keep it out of Cursor context via `.cursorignore`. Do not paste a full duplicate of this file into `CLAUDE.md`.
- CI now includes backend tests, build/download-manifest tests, main-process and renderer helper JS tests, plus Windows/macOS packaged-build smoke checks, but it is still not full end-to-end product coverage.
- Root `README.md` is broadly useful, but some product docs may still lag code changes.
- `backend/meeting_manager.py` now uses locked atomic metadata writes, transactional add behavior, and corrupt-file backups.
- `src/renderer/app.js` still has a TODO for saving transcripts through a file dialog.

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
- `npm run test:all`: runs both JS and Python suites
- Characterization gates for the codebase refactor: IPC/compute-queue source-scan and facade export snapshots under `tests/js/`; recorder stdout contracts under `tests/js/recorder-event-contract.test.js` and `tests/python/test_recorder_event_contract.py`
- Manual recorder validation checklist lives in `tests/manual/recording-smoke-checklist.md`
- Setup instructions for new machines live in `docs/development/TESTING.md`

### CI-style validation

```bash
npm test
npm run test:python
python -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py
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
- `src/main.js` parser logic
- any renderer UI states that depend on that progress

### If you change saved meeting file names or locations

Update all of:

- recorder output path logic
- `backend/meeting_manager.py`
- scan/import logic
- delete logic
- any renderer assumptions about playback paths

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

- `src/main.js`: very large, many responsibilities, easy to regress via small output-contract changes
- `src/renderer/app.js`: large stateful UI file with many implicit assumptions
- `backend/audio/windows_recorder.py`: timing-sensitive, sample-rate-sensitive, callback-sensitive
- `backend/audio/macos_recorder.py`: threading plus native helper integration plus permission edge cases
- `build/prepare-resources.js`: packaging-critical and platform-specific

## Guidance For Future Refactors

- Prefer extracting logic behind stable interfaces instead of rewriting whole flows.
- Keep platform-specific behavior explicit rather than hiding it behind overly clever abstractions.
- Preserve user-facing resilience: many handlers intentionally degrade gracefully instead of hard-failing.
- When simplifying code, preserve the current operational behavior first, then reduce complexity.
- Keep `todo.md` updated whenever task status changes, major progress is made, or execution order is adjusted.

## When In Doubt

- Trust the current runtime scripts and CI over stale docs.
- Inspect both Electron and Python sides before changing any cross-process contract.
- Favor targeted, low-risk edits over architecture rewrites unless the task explicitly calls for a redesign.
