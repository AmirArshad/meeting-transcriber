# Full Audit Remediation Plan

Branch: `fix/full-audit-remediation`

Status: active. Phase 00 is complete. Batch 1 is in progress.

## Working Rule

- Update this `todo.md` whenever task status changes, major progress is made, or execution order is adjusted.

## Progress Snapshot

- Completed Phase 00 regression safety net work.
- Added a Python test harness with `pytest` plus `requirements-dev.txt` and `pytest.ini`.
- Added JS regression tests for main-process helper logic and syntax checks.
- Added `npm test`, `npm run test:python`, and `npm run test:all`.
- Added `docs/development/TESTING.md` and updated setup/build docs for new machines.
- Wired the regression suite into CI.
- Started Batch 1 and completed the first contract-focused macOS fixes:
  - structured recorder stdout parsing in Electron
  - more truthful macOS recorder startup behavior
  - stricter Swift helper readiness handling
  - Swift helper audio extraction rewrite for full `AudioBufferList` handling
- Completed the Swift helper write-queue/backpressure fix to decouple ScreenCaptureKit callbacks from blocking stdout writes.
- Implemented macOS stream alignment using observed first-audio timestamps so startup lag becomes leading silence instead of dropped beginning audio.
- Tightened macOS stop/drain handling so the helper reader stays alive through process exit and preserves more tail audio during shutdown.
- Improved preroll/start-offset consistency by aligning both streams against the same post-preroll reference point.
- Started Batch 2 and fixed channel-safe resampling so interleaved multi-channel audio is resampled per channel instead of as one flat stream.
- Latest automated validation status at time of update:
  - `npm run test:all` passing
  - `swift build -c release --arch arm64` passing

## Goals

- Restore reliable macOS desktop audio capture for transcription.
- Eliminate data-loss, corruption, and race-condition risks.
- Reduce memory pressure for long recordings.
- Harden Electron/Python/Swift process contracts.
- Improve build, packaging, updater, and CI reliability.
- Clean up low-level code quality issues without changing core product behavior.

## Recommended Execution Order

1. P0: build a minimal high-value regression suite
2. P0: macOS desktop audio correctness and startup truthfulness
3. P0: data integrity and audio-processing correctness
4. P1: cross-process contract cleanup and graceful shutdown
5. P1: memory/performance hardening
6. P2: build/release/update pipeline hardening
7. P2: renderer safety, docs, and code quality cleanup

## Phase 00 - Minimal Regression Suite Before Fixes

This phase exists to reduce regression risk before touching the recorder, persistence,
and cross-process contracts. The goal is not a huge test suite up front. The goal is
to create a tight safety net around the highest-risk logic so large remediation work
does not silently break Windows, meeting history, or transcription flows while we fix
macOS desktop audio.

### 0.1 Test harness foundation

- [x] Add a Python test harness with `pytest`.
- [x] Add a JavaScript test harness using built-in `node:test` where practical.
- [x] Create a `tests/` structure that separates:
  - pure Python unit tests
  - JS contract/parsing tests
  - fixtures/sample payloads
- [x] Prefer dependency-light tests that can run in CI without real audio hardware.

Files:

- `requirements-dev.txt` or equivalent test dependency location
- `tests/`
- `package.json`
- `.github/workflows/ci.yml`

### 0.2 Highest-value Python regression tests

- [x] Add tests for `backend/audio/processor.py`:
  - stereo-safe resampling
  - mono-to-stereo behavior
  - clipping/casting boundaries
- [x] Add tests for `backend/audio/timeline.py`:
  - silence-gap reconstruction
  - overlap trimming
  - target-duration padding
- [x] Add tests for `backend/audio/compressor.py`:
  - ffmpeg missing fallback contract
  - failed compression fallback behavior
- [x] Add tests for `backend/meeting_manager.py`:
  - duplicate ID prevention
  - scan/import correctness
  - delete behavior
  - corrupt metadata recovery behavior after refactor
- [x] Add tests for transcription runtime helpers where feasible:
  - model lock handling
  - cache-path detection logic

Files:

- `backend/audio/processor.py`
- `backend/audio/timeline.py`
- `backend/audio/compressor.py`
- `backend/meeting_manager.py`
- `backend/transcription/faster_whisper_transcriber.py`
- `backend/transcription/mlx_whisper_transcriber.py`
- `tests/`

### 0.3 Highest-value JavaScript regression tests

- [x] Add tests for recorder output parsing logic extracted from `src/main.js`.
- [x] Add tests for handling structured stdout messages:
  - `levels`
  - `warning`
  - `error`
  - mixed/chunked line delivery
- [x] Add tests for model-cache detection logic, especially macOS MLX cache behavior.
- [ ] Add tests for start/stop/quit state transitions where logic can be isolated without Electron UI automation.

Files:

- `src/main.js`
- `tests/`

### 0.4 Manual smoke suite for hardware-dependent behavior

- [x] Create a manual smoke checklist for flows that cannot be trusted to automation alone:
  - macOS desktop audio capture with real system audio
  - Screen Recording denied
  - no desktop audio playing
  - quit during active recording
  - long recording stop/drain
  - Windows mic + loopback mixed recording
- [ ] Store representative fixtures/logs from current failure scenarios where useful.

Files:

- `docs/` or `tests/manual/`

### 0.5 CI integration for the minimal suite

- [x] Run the new Python and JS regression tests in CI.
- [x] Keep the suite fast enough to run on every push.
- [x] Do not block on full end-to-end hardware automation yet.

Files:

- `.github/workflows/ci.yml`

## Phase 0 - Guardrails Before Refactors

- [x] Create a reproducible manual test checklist for:
  - macOS mic + desktop audio recording
  - no Screen Recording permission
  - no desktop audio playing
  - quit during active recording
  - long recording stop/post-processing
  - Windows mixed mic + loopback capture
- [ ] Add a lightweight regression checklist file for all future recording/transcription changes.
- [ ] Capture and save example logs from current macOS failure scenarios before changing behavior.

## Phase 1 - Fix macOS Desktop Audio Capture Reliability

### 1. Swift helper audio extraction correctness

- [x] Rework `swift/AudioCaptureHelper/Sources/main.swift` audio extraction to handle the full `AudioBufferList`, not just the first buffer.
- [x] Detect and correctly handle interleaved vs non-interleaved/planar audio.
- [x] Normalize helper output to one explicit format before writing to stdout:
  - float32
  - interleaved
  - expected channel count
  - expected sample rate
- [x] Preserve and improve format validation and error reporting when incoming ScreenCaptureKit frames do not match assumptions.
- [x] Add targeted debug logging for first-frame format details and buffer layout, but keep logs bounded.

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`

### 2. Prevent callback-path pipe backpressure

- [x] Decouple ScreenCaptureKit callback handling from stdout writes in the Swift helper.
- [x] Add a bounded queue/ring buffer plus dedicated writer path so slow Python reads do not stall capture.
- [x] Decide and implement overflow behavior explicitly:
  - bounded memory
  - logged drops if unavoidable
  - no deadlock in capture callback

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`

### 3. Make startup state truthful

- [x] Require explicit desktop-capture readiness before claiming recording has started.
- [x] Stop treating "no ready signal but continuing" as success in `backend/audio/swift_audio_capture.py`.
- [x] Make `backend/audio/macos_recorder.py` fail startup or degrade explicitly based on whether desktop capture is required/available.
- [x] Do not print `Recording started!` until mic capture and desktop capture readiness are both known.
- [x] Add a consistent startup event/status contract for macOS that mirrors the Windows progress stages.

Files:

- `backend/audio/swift_audio_capture.py`
- `backend/audio/macos_recorder.py`
- `src/main.js`

### 4. Parse structured recorder output properly in Electron

- [x] Replace the current stdout parser in `src/main.js` with line-by-line JSON parsing for all structured messages.
- [x] Support at least:
  - `levels`
  - `warning`
  - `error`
  - future `event`/`progress` messages
- [x] Surface macOS desktop capture warnings/errors to the renderer instead of treating them as generic progress text.
- [ ] Keep stderr for human-readable logs only.

Files:

- `src/main.js`
- `backend/audio/macos_recorder.py`
- `backend/audio/windows_recorder.py`

### 5. Fix macOS stream alignment

- [x] Stop relying on tail padding alone in `backend/audio/macos_recorder.py`.
- [x] Capture first-sample timestamps/sample counters for mic and desktop streams.
- [x] Insert leading silence based on actual startup offset so desktop audio is aligned from the beginning.
- [x] Ensure preroll handling is consistent across both streams.

Files:

- `backend/audio/macos_recorder.py`
- `backend/audio/swift_audio_capture.py`

### 6. Improve macOS stop/drain behavior

- [x] After sending `stop`, keep draining helper stdout until EOF/process exit rather than sleeping a fixed 300 ms and stopping readers early.
- [x] Make helper shutdown semantics explicit and deterministic.
- [x] Ensure tail audio is preserved at stop time.

Files:

- `backend/audio/swift_audio_capture.py`
- `swift/AudioCaptureHelper/Sources/main.swift`

### 7. Real permission detection

- [ ] Add a helper-level permission probe mode, e.g. `--check-permission`, instead of returning unconditional `True` from Python.
- [ ] Surface actionable macOS permission status to Electron before recording begins.
- [ ] Make UI guidance precise for Screen Recording vs Microphone permission failures.

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`
- `backend/audio/swift_audio_capture.py`
- `backend/check_permissions.py`
- `src/main.js`

### 8. Harden PyObjC fallback path

- [ ] Make `backend/audio/screencapture_helper.py` handle multi-buffer/planar audio correctly.
- [ ] Ensure fallback output format matches the Swift helper contract.
- [ ] Re-test fallback only after the primary Swift path is stable.

Files:

- `backend/audio/screencapture_helper.py`

### 9. Reconcile macOS capture messaging and docs

- [ ] Validate the real behavior of Bluetooth/USB/external output-device capture on current macOS target versions.
- [ ] Align code comments, warnings, and docs so they do not contradict each other.

Files:

- `backend/audio/screencapture_helper.py`
- `src/main.js`
- `docs/features/MACOS_AUDIO_ARCHITECTURE.md`
- `docs/TROUBLESHOOTING.md`

## Phase 2 - Fix Audio Processing Correctness and Data Integrity

### 10. Fix resampling for multichannel/interleaved audio

- [x] Update `backend/audio/processor.py::resample()` to reshape by channel and resample along the frame axis.
- [x] Preserve channel separation for stereo/multichannel audio.
- [x] Clip float output before casting back to `int16`.
- [x] Review all call sites to ensure channel count assumptions remain correct.

Files:

- `backend/audio/processor.py`
- `backend/audio/windows_recorder.py`

### 11. Fix Opus fallback behavior

- [ ] Change `compress_to_opus()` fallback to avoid copying WAV data to a `.opus` path.
- [ ] Pick one explicit fallback strategy:
  - return a real `.wav` path, or
  - raise and let caller handle failure
- [ ] Make integrity-check failure a hard failure or fallback trigger rather than a warning-only path.

Files:

- `backend/audio/compressor.py`
- `backend/audio/windows_recorder.py`
- `backend/audio/macos_recorder.py`

### 12. Make meeting metadata writes safe

- [ ] Add inter-process file locking around all `meetings.json` reads/writes.
- [ ] Write via temp file + fsync + `os.replace()` for atomic persistence.
- [ ] Prevent concurrent `add`/`scan`/`delete` from corrupting metadata.

Files:

- `backend/meeting_manager.py`

### 13. Make meeting persistence transactional

- [ ] Rework `add_meeting()` so originals are only deleted after metadata is durably saved.
- [ ] Add rollback/cleanup behavior when copy or metadata write fails.
- [ ] Avoid orphaning persisted files or losing originals.

Files:

- `backend/meeting_manager.py`

### 14. Handle metadata corruption safely

- [ ] Stop silently treating `JSONDecodeError` as an empty meeting list.
- [ ] Back up corrupt `meetings.json` automatically.
- [ ] Surface a recovery warning instead of wiping history on next save.

Files:

- `backend/meeting_manager.py`

### 15. Fix scan/import bugs

- [ ] Move `re` import out of the fragile `try` block.
- [ ] Fix the filename regex to preserve suffixed IDs like `meeting_20260107_104555_1`.
- [ ] Ensure scan/import does not collapse distinct meetings onto one ID.

Files:

- `backend/meeting_manager.py`

### 16. Revisit transcript storage strategy

- [ ] Stop inlining full transcript bodies into `meetings.json`, or make it explicitly lazy-loaded.
- [ ] Store only summary metadata in the index and load transcript text from disk on demand.
- [ ] Update renderer/detail views accordingly.

Files:

- `backend/meeting_manager.py`
- `src/main.js`
- `src/renderer/app.js`

## Phase 3 - Fix Transcription Runtime Issues

### 17. Honor model download locks consistently

- [ ] Change `backend/transcription/faster_whisper_transcriber.py` to fail or retry on lock timeout instead of bypassing the lock.
- [ ] Keep Windows/default behavior aligned with MLX timeout semantics.

Files:

- `backend/transcription/faster_whisper_transcriber.py`

### 18. Fix MLX transcriber behavior

- [ ] Pass requested language/task options to `lightning-whisper-mlx` if supported.
- [ ] If explicit language is unsupported, make that limitation explicit in UI and code.
- [ ] Stop changing process-wide CWD during model load.
- [ ] Configure cache path without `os.chdir()` if possible; otherwise isolate loading in a subprocess.
- [ ] Derive audio duration robustly when no segment timestamps are returned.

Files:

- `backend/transcription/mlx_whisper_transcriber.py`
- `src/main.js`
- `src/renderer/app.js`

### 19. Clean up transcription abstraction surface

- [ ] Either make real transcribers implement `BaseTranscriber`, or remove the unused abstraction.
- [ ] Normalize naming/signatures (`transcribe` vs `transcribe_file`) across implementations.

Files:

- `backend/transcription/base_transcriber.py`
- `backend/transcription/faster_whisper_transcriber.py`
- `backend/transcription/mlx_whisper_transcriber.py`

## Phase 4 - Fix Electron Process Management and UI Safety

### 20. Graceful quit during recording

- [ ] Replace kill-on-quit behavior with a graceful stop path when a recording is in progress.
- [ ] If graceful stop is not possible, prompt the user clearly before data-loss actions.
- [ ] Ensure `before-quit` does not discard in-progress recordings.

Files:

- `src/main.js`

### 21. Fix macOS model cache detection

- [ ] Point `check-model-downloaded` at the actual MLX cache location used by the app.
- [ ] Keep macOS and Windows model detection logic distinct and explicit.

Files:

- `src/main.js`
- `backend/transcription/mlx_whisper_transcriber.py`

### 22. Use preflight checks before recording

- [ ] Wire `validateDevices`, `checkDiskSpace`, and `checkAudioOutput` into the actual `startRecording()` flow.
- [ ] Block or warn before recording when checks fail.
- [ ] Keep platform-specific guidance accurate.

Files:

- `src/preload.js`
- `src/renderer/app.js`
- `src/main.js`

### 23. Improve progress/event contracts

- [ ] Move transcription progress to stderr or structured status events only.
- [ ] Reserve stdout for final machine-readable JSON payloads.
- [ ] Standardize recording startup/progress events across macOS and Windows.
- [ ] Remove remaining brittle stderr string dependencies where practical.

Files:

- `src/main.js`
- `backend/audio/windows_recorder.py`
- `backend/audio/macos_recorder.py`
- `backend/transcription/faster_whisper_transcriber.py`
- `backend/transcription/mlx_whisper_transcriber.py`

### 24. Remove renderer injection/path risks

- [ ] Replace `innerHTML` assignments with DOM node creation plus `textContent` where backend/user-derived strings are involved.
- [ ] Convert audio file paths using a safe file-URL helper instead of manual string concatenation.

Files:

- `src/renderer/app.js`
- `src/preload.js`
- `src/main.js`

### 25. Clean up preload event APIs

- [ ] Return unsubscribe functions from preload listener helpers.
- [ ] Consider `once`/`off` wrappers for one-shot events.

Files:

- `src/preload.js`
- `src/renderer/app.js`

### 26. Fix window icon pathing

- [ ] Point `BrowserWindow` icon at a real existing asset in dev and packaged modes.

Files:

- `src/main.js`

## Phase 5 - Performance and Memory Hardening

### 27. Reduce long-recording RAM usage

- [ ] Replace fully in-memory recording/mixing with chunked temp-file or streaming approaches where feasible.
- [ ] Prioritize the heaviest buffers first:
  - macOS mic frames
  - macOS desktop buffer
  - Windows joined frame buffers
  - final mix buffer
- [ ] Preserve current post-processing mix architecture while reducing peak allocations.

Files:

- `backend/audio/macos_recorder.py`
- `backend/audio/swift_audio_capture.py`
- `backend/audio/windows_recorder.py`
- `backend/audio/timeline.py`

### 28. Reduce Windows callback contention

- [ ] Move expensive level calculations out of shared callback locks.
- [ ] Consider per-stream queues/locks for mic vs loopback.
- [ ] Track mic and desktop callback health separately so one stream does not mask failure of the other.

Files:

- `backend/audio/windows_recorder.py`

### 29. Keep current timeline reconstruction strengths while optimizing

- [ ] Preserve the incremental/chunked silence reconstruction approach in `timeline.py`.
- [ ] Ensure any refactor does not regress the memory win already present there.

Files:

- `backend/audio/timeline.py`

## Phase 6 - Build, Packaging, Updater, and CI Hardening

### 30. Fix stale build resource reuse

- [ ] Invalidate or version-stamp `build/resources` so old Python/ffmpeg/helper artifacts are not silently reused.
- [ ] Extend `prepare-build` cleanup beyond `dist/` when runtime versions change.

Files:

- `package.json`
- `build/prepare-resources.js`

### 31. Verify downloaded build artifacts

- [ ] Add checksum verification for downloaded Python, ffmpeg, `get-pip.py`, and any other fetched build-time artifacts.
- [ ] Fail fast on mismatch before extraction/execution.

Files:

- `build/prepare-resources.js`

### 32. Make helper path resolution less brittle

- [ ] Use `swift build --show-bin-path` or equivalent at build time instead of hardcoded `.build/...` path guesses.
- [ ] Keep dev/runtime helper lookup aligned with packaged resource layout.

Files:

- `build/prepare-resources.js`
- `backend/audio/swift_audio_capture.py`

### 33. Fix release publication flow

- [ ] Split matrix build jobs from release creation.
- [ ] Upload artifacts in parallel, then create/update the GitHub release once in a final aggregation job.
- [ ] Ensure release notes list all assets consistently.

Files:

- `.github/workflows/build-release.yml`

### 34. Align updater asset detection with actual build outputs

- [ ] Decide whether macOS zip should remain part of release/update behavior.
- [ ] If yes, make artifact naming explicit and updater matching deterministic.
- [ ] If no, remove dead updater fallback logic.

Files:

- `src/updater.js`
- `package.json`
- `.github/workflows/build-release.yml`

### 35. Strengthen CI

- [ ] Replace the current frontend "validation" step with real checks.
- [ ] Add at minimum:
  - `node --check src/main.js`
  - `node --check src/preload.js`
  - `node --check src/renderer/app.js`
  - Python compile checks
  - Swift helper build check on macOS
  - one packaged-build smoke test if practical

Files:

- `.github/workflows/ci.yml`

## Phase 7 - Code Quality and Developer Experience Cleanup

### 36. Replace import-time hard exits in shared modules

- [ ] Refactor `backend/device_manager.py` to raise structured errors instead of calling `sys.exit()` at import time.
- [ ] Keep CLI behavior by exiting only in the CLI wrapper.

Files:

- `backend/device_manager.py`

### 37. Update stale docs and repo guidance

- [ ] Fix `docs/development/BUILD_INSTRUCTIONS.md` to use `npm run prepare-build`.
- [ ] Update macOS architecture/troubleshooting docs after capture fixes land.
- [ ] Add notes for the new structured recorder event contract if implemented.

Files:

- `docs/development/BUILD_INSTRUCTIONS.md`
- `docs/TROUBLESHOOTING.md`
- `docs/features/MACOS_AUDIO_ARCHITECTURE.md`
- `docs/features/json-based-events.md`

## Validation Matrix

### macOS functional validation

- [ ] Record mic + desktop audio with active system audio; verify desktop audio is audible in final transcript source.
- [ ] Verify first 10 seconds of desktop audio are not missing.
- [ ] Verify no-Screen-Recording-permission flow fails clearly before recording.
- [ ] Verify mic-only degradation path is explicit if desktop capture is unavailable.
- [ ] Verify packaged macOS build still bundles and launches `audiocapture-helper`.
- [ ] Verify helper still builds with `swift build -c release --arch arm64`.

### Windows functional validation

- [ ] Verify stereo/multichannel resampling no longer distorts channels.
- [ ] Verify mixed mic + loopback output still sounds correct after processor changes.
- [ ] Verify heartbeat/per-stream failure reporting catches dead desktop stream and dead mic stream independently.

### Transcription validation

- [ ] Verify preload/model-download flow works on Windows and macOS.
- [ ] Verify selected language is honored or clearly documented when unsupported.
- [ ] Verify stdout remains parseable final JSON only.

### Meeting history validation

- [ ] Verify add/delete/scan can run repeatedly without corrupting `meetings.json`.
- [ ] Verify concurrent operations do not lose metadata.
- [ ] Verify corrupt `meetings.json` is backed up and surfaced safely.

### Lifecycle validation

- [ ] Verify quitting during an active recording does not silently lose data.
- [ ] Verify stop/post-processing preserves full tail audio.
- [ ] Verify long recordings do not cause runaway memory growth.

## Suggested Implementation Batches

### Batch 0 - regression safety net

- [x] Python test harness
- [x] JS contract/parsing harness
- [x] high-value unit tests for processor/timeline/compressor/meeting manager
- [x] high-value JS tests for main-process parsing and cache detection
- [x] manual smoke checklist

### Batch 1 - macOS desktop audio hot path

- [x] Swift helper buffer extraction fix
- [x] helper write-queue/backpressure fix
- [x] truthful startup/ready contract
- [x] Electron structured stdout parsing
- [x] macOS stream alignment fix
- [x] macOS stop/drain fix

### Batch 2 - integrity-critical backend fixes

- [x] channel-safe resampling
- [ ] safe Opus fallback
- [ ] atomic + locked meeting metadata writes
- [ ] transactional meeting persistence
- [ ] corruption recovery
- [ ] scan/import bug fixes

### Batch 3 - transcription/runtime contract cleanup

- [ ] faster-whisper lock timeout behavior
- [ ] MLX cache/language/CWD cleanup
- [ ] transcription progress contract cleanup
- [ ] shared transcriber abstraction cleanup

### Batch 4 - app lifecycle, UI, and build hardening

- [ ] graceful quit during recording
- [ ] preflight checks before start
- [ ] safe renderer DOM updates and file URLs
- [ ] stronger CI
- [ ] release workflow aggregation
- [ ] build artifact checksum verification

## Notes

- Build the smallest useful regression suite before major remediation work; do not wait for a perfect test architecture.
- Keep hardware-dependent recorder validation as manual smoke tests even after automated tests are added.
- Preserve the current post-processing mix architecture unless a later redesign is explicitly approved.
- Preserve local-only/privacy-first behavior.
- Keep Windows and macOS recorder output contracts aligned when changing process messaging.
- Prefer targeted fixes over broad rewrites unless a subsystem becomes simpler and safer as a result.
